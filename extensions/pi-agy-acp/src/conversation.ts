/**
 * Per-conversation ACP session state and the turn pump that maps one ACP
 * prompt turn onto Pi model steps.
 *
 * An ACP prompt turn can span many model calls: the agent calls a Pi tool
 * through the MCP bridge, the call parks, and the pump ends the current Pi
 * step with `finish(tool-calls)`. Pi runs the tool through its own pipeline
 * and opens the next step with the result, which resolves the parked call and
 * resumes the same ACP turn. Parked calls that approach the agent's 180s MCP
 * deadline proactively detach via `session/cancel` and drain so the real tool
 * result is delivered cleanly in a fresh continuation turn.
 * @module pi-agy-acp/conversation
 */

import { LlmError } from './protocol.ts'
import type { ContentBlock, StreamChunk, TokenUsage } from './protocol.ts'
import type {
  AcpPromptResult,
  AcpSessionUpdate,
  AcpPermissionRequest,
  AcpToolCallMeta,
} from './acp-process.ts'
import type {
  BridgeCallRequest,
  BridgeTool,
  BridgeToolResult,
} from './mcp-bridge.ts'
import {
  CALL_TOOL_NAME,
  MCP_SERVER_NAME,
} from './history.ts'
import { NativeWriteActivity } from './native-write-activity.ts'
import { AsyncQueue, deferred, type Deferred } from './util.ts'

/** Agent-side transport retry notice streamed as message text, e.g. `⚠ API error (attempt 1): …`. */
const AGENT_RETRY_NOTICE = /^\s*⚠\s*API error \(attempt \d+\)/
/** First sentence of the notice agy inserts when one generation hits its own output cap. */
const OUTPUT_LIMIT_HEAD =
  'your previous response was cut off because it exceeded the output token limit'
/** Second sentence of that same notice. */
const OUTPUT_LIMIT_TAIL =
  'please continue from where you left off, keeping your response shorter'
/** Internal retry notice agy emits when an upstream stream is interrupted mid-turn. */
const STREAM_INTERRUPTED =
  'the stream was interrupted. please continue the task you were working on.'
/** Internal retry notice agy emits when a model response contains neither text nor tool calls. */
const EMPTY_MODEL_OUTPUT =
  'model output error: model output must contain either output text or tool calls, these cannot both be empty, please try again'
const EMPTY_MODEL_OUTPUT_BODY =
  'model output must contain either output text or tool calls, these cannot both be empty, please try again'
/** Generic retry notice prefix paired with a trailing `Retries remaining: <N>`. */
const PROBLEM_RETRY_PREFIX = 'there was a problem'
/** Cap on held characters while waiting for `Retries remaining: <N>` after `There was a problem`. */
const MAX_PROBLEM_NOTICE_CHARS = 512

/** Collapse agy's warning mark, line-leading `Error:`, and line breaks so notices match across chunks. */
function noticeText(raw: string): string {
  return raw
    .replace(/⚠/g, ' ')
    .replace(/(?:^|\n)\s*error:\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Classify text against agy's internal retry and output-cap continuation notices.
 * `drop` is only an internal notice, `hold` is still a prefix of one, `emit` is model text.
 */
export function classifyOutputLimitNotice(
  raw: string,
): 'drop' | 'hold' | 'emit' {
  const text = noticeText(raw)
  if (text.length === 0) return raw.includes('⚠') ? 'hold' : 'emit'
  // Terminal exhaustion (`Retries remaining: 0`) must surface immediately instead of being dropped or held.
  if (/\bretries remaining:\s*0+$/i.test(text)) return 'emit'
  if (/^there was a problem\b/.test(text)) {
    if (/\bretries remaining:\s*[1-9]\d*$/.test(text)) return 'drop'
    return text.length <= MAX_PROBLEM_NOTICE_CHARS ? 'hold' : 'emit'
  }
  if (PROBLEM_RETRY_PREFIX.startsWith(text) && text.startsWith('there was'))
    return 'hold'
  const stripped = text.replace(/\s*retries remaining:\s*\d*\s*$/i, '').trim()
  const retry = text.slice(stripped.length).trim()
  if (retry.length > 0 && !/^retries remaining:\s*\d*$/i.test(retry))
    return 'emit'
  if (stripped.length === 0) {
    if (/^retries remaining:\s*[1-9]\d*$/i.test(text)) return 'drop'
    return /^retries remaining:\s*$/i.test(text) ? 'hold' : 'emit'
  }
  const full = `${OUTPUT_LIMIT_HEAD} ${OUTPUT_LIMIT_TAIL}`
  if (
    stripped === full ||
    stripped === OUTPUT_LIMIT_HEAD ||
    stripped === OUTPUT_LIMIT_TAIL ||
    stripped === STREAM_INTERRUPTED ||
    stripped === EMPTY_MODEL_OUTPUT ||
    stripped === EMPTY_MODEL_OUTPUT_BODY
  ) {
    if (retry.length === 0 || /^retries remaining:\s*[1-9]\d*$/i.test(retry))
      return 'drop'
    return /^retries remaining:\s*$/i.test(retry) ? 'hold' : 'emit'
  }
  if (full.startsWith(stripped) && stripped.startsWith('your previous'))
    return 'hold'
  if (
    OUTPUT_LIMIT_TAIL.startsWith(stripped) &&
    stripped.startsWith('please continue from where you left off')
  )
    return 'hold'
  if (
    STREAM_INTERRUPTED.startsWith(stripped) &&
    stripped.startsWith('the stream')
  )
    return 'hold'
  if (
    (EMPTY_MODEL_OUTPUT.startsWith(stripped) ||
      EMPTY_MODEL_OUTPUT_BODY.startsWith(stripped)) &&
    stripped.startsWith('model output')
  )
    return 'hold'
  if ('retries remaining:'.startsWith(text) && text.startsWith('retries'))
    return 'hold'
  return 'emit'
}

/** MCP descriptor of {@link CALL_TOOL_NAME} (~340B, stays below agy's lazy cutoff). */
export const CALL_TOOL: BridgeTool = {
  name: CALL_TOOL_NAME,
  description:
    'Invoke any harness tool by exact name when mcp_pi_<name> is absent from your direct tool declarations.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Exact Pi tool name without mcp_pi_ prefix.',
      },
      arguments: {
        type: 'object',
        description: 'Arguments object matching that tool schema.',
      },
    },
    required: ['name'],
  },
}

/** One tool call the agent issued and Pi has to run. */
export interface ParkedCall {
  readonly id: string
  readonly name: string
  readonly argumentsJson: string
  readonly result: Deferred<BridgeToolResult>
}

/** Event observed during one ACP turn. */
export type TurnEvent =
  | { kind: 'thought'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'park'; call: ParkedCall }
  | { kind: 'done'; result: AcpPromptResult }
  | { kind: 'error'; error: Error }

/** One running ACP prompt turn. */
export class AcpTurn {
  readonly cancellation = new AbortController()
  /** First interruption wins; prompt completion is committed only after the step drains. */
  private terminal: { kind: 'cancelled' } | { kind: 'failed'; error: Error } | undefined
  releaseSignal: (() => void) | undefined
  readonly startedAt = performance.now()
  readonly events = new AsyncQueue<TurnEvent>()
  readonly nativeWriteActivity = new NativeWriteActivity()
  /** Calls handed to Pi whose results have not arrived yet. */
  readonly pendingCalls = new Map<string, ParkedCall>()
  /** Calls the agent issued during this turn. */
  readonly calls = new Map<string, ParkedCall>()
  /** Pi steps this turn has ended with `tool-calls`. */
  toolSteps = 0
  /** Tool steps completed inside the active `session/prompt` segment. */
  segmentToolSteps = 0
  /** Long-decode continuations sent in this turn. */
  continuations = 0
  /** The agent ended the prompt. */
  finished = false
  /** True while an ACP `session/prompt` RPC for this turn has not yet settled. */
  private promptActive = false
  /** Settles after the current prompt's result or error has been queued. */
  promptSettled: Promise<void> = Promise.resolve()
  /** Cancel-and-drain detach lifecycle when a Pi tool approaches agy's 180s MCP timeout. */
  private detachState: 'none' | 'detaching' | 'detached' = 'none'
  /** Resolves once the cancelled prompt has drained (or timed out). */
  detachDrain: Promise<void> | undefined
  /** True if cancel-and-drain failed or timed out so the caller should rebuild/resume cleanly. */
  detachFailed = false
  /** True while a newer mid-turn steer prompt is superseding this turn's prompt RPC. */
  steeringOut = false
  /** Accumulated visible text emitted in the latest streamed step (for checkpoint verification). */
  stepText = ''
  usage?: AcpPromptResult['usage']
  /** Latest positive single-call context occupancy reported via `usage_update.used`. */
  contextUsed?: number
  /** Fallback single-call context occupancy decoded from same-turn `gen_metadata` (`estimated_tokens_used`). */
  estimatedContextUsed?: number
  /** Lower `gen_metadata.idx` bound owned by the active turn segment, or `null` when unobservable. */
  metaFloorIdx: number | null = 0
  /** Highest `steps.idx` already persisted before the active prompt segment started, or `null` when unobservable. */
  lastStepIdx: number | null = -1
  /** Deferred harness tool-delta suffixes attached to the next resolved MCP call result. */
  private readonly pendingSuffix: string[] = []
  /** The turn produced visible text or a tool call. */
  produced = false
  /** Agent-side transport retry notices dropped from the output. */
  retryNotices = 0
  /** Message text that may still be the start of agy's output-cap notice. */
  private noticeHold = ''
  private nextCall = 0
  private readonly turnTag: string

  /** @param turnTag - unique per-turn hex tag used in synthesized call ids (`agy_<turnTag>_<n>`). */
  constructor(turnTag: string) {
    this.turnTag = turnTag
  }

  /** Authoritative liveness of the underlying ACP `session/prompt` RPC. */
  get isPromptActive(): boolean {
    return (
      this.promptActive &&
      !this.finished &&
      this.terminal === undefined &&
      this.detachState === 'none'
    )
  }

  /** Whether this turn has started or completed cancel-and-drain detachment. */
  get isDetachingOrDetached(): boolean {
    return this.detachState !== 'none'
  }

  /**
   * Bind one ACP `session/prompt` RPC promise to this turn's lifecycle.
   * Clears `promptActive` the instant the RPC settles so tool-result delivery
   * never has to guess liveness from the head of `events`.
   */
  bindPrompt(
    promise: Promise<AcpPromptResult>,
    options?: {
      mapError?: (error: unknown) => Error
    },
  ): void {
    this.promptActive = true
    this.promptSettled = promise.then(
      (result) => {
        this.promptActive = false
        if (this.detachState !== 'none' || this.steeringOut) return
        this.events.push({ kind: 'done', result })
      },
      (error: unknown) => {
        this.promptActive = false
        if (this.detachState !== 'none') {
          this.detachFailed = true
          return
        }
        if (this.steeringOut) return
        this.fail(
          options?.mapError !== undefined
            ? options.mapError(error)
            : error instanceof Error
              ? error
              : new Error(String(error)),
        )
      },
    )
  }

  /**
   * Proactively cancel and drain a parked ACP turn before `agy`'s 180s MCP
   * deadline hits. Idempotent across parallel parked calls in the same turn.
   */
  startDetach(cancel: () => void, cancelTimeoutMs: number): Promise<void> {
    if (this.detachDrain !== undefined) return this.detachDrain
    this.detachState = 'detaching'
    this.noticeHold = ''
    try {
      cancel()
    } catch {
      this.detachFailed = true
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(100, cancelTimeoutMs))
      timer.unref?.()
    })
    this.detachDrain = Promise.race([
      this.promptSettled.then(() => 'settled' as const),
      timeout,
    ])
      .then((outcome) => {
        if (outcome === 'timeout') this.detachFailed = true
        this.detachState = 'detached'
      })
      .finally(() => {
        if (timer !== undefined) clearTimeout(timer)
      })
    return this.detachDrain
  }

  /**
   * Register one agent tool call.
   * @param name - Pi tool name.
   * @param args - parsed arguments.
   * @returns the parked call.
   */
  park(name: string, args: Record<string, unknown>): ParkedCall {
    const call: ParkedCall = {
      id: `agy_${this.turnTag}_${++this.nextCall}`,
      name,
      argumentsJson: JSON.stringify(args),
      result: deferred<BridgeToolResult>(),
    }
    this.calls.set(call.id, call)
    this.events.push({ kind: 'park', call })
    return call
  }

  /**
   * Park one Pi tool call and wait for its result. If execution outlives
   * `detachAfterMs`, proactively cancels and drains the ACP turn via `onDetach`
   * so the real result can be delivered cleanly in a fresh continuation turn.
   */
  invokeTool(
    name: string,
    args: Record<string, unknown>,
    detachAfterMs: number,
    onDetach: () => void,
    signal: AbortSignal,
    commit?: BridgeCallRequest['commit'],
  ): Promise<BridgeToolResult> {
    return this.awaitCall(
      this.park(name, args),
      detachAfterMs,
      onDetach,
      signal,
      commit,
    )
  }

  /**
   * Deliver Pi's tool results for the currently pending batch.
   * When the ACP prompt is still active, resolves the parked calls and defers any
   * harness suffix onto the next delivered MCP result; otherwise returns the
   * pending batch and combined suffix so the owner can open a continuation prompt.
   */
  deliverToolResults(
    results: ReadonlyMap<string, BridgeToolResult>,
    suffix: string,
  ):
    | { resumed: true }
    | { resumed: false; pending: ParkedCall[]; suffix: string } {
    const pending = [...this.pendingCalls.values()]
    this.pendingCalls.clear()
    if (!this.isPromptActive) {
      const carried = this.consumePendingSuffix()
      return {
        resumed: false,
        pending,
        suffix: [carried, suffix].filter(Boolean).join('\n\n'),
      }
    }
    if (suffix.length > 0) this.pendingSuffix.push(suffix)
    for (const call of pending) {
      const result = results.get(call.id)
      if (result === undefined) continue
      call.result.resolve(result)
    }
    return { resumed: true }
  }

  /**
   * Resolve parked MCP calls after a mid-turn `session/prompt` steer has been
   * accepted by `agy` (and `promptSettled` resolved).
   */
  resolveParkedForSteer(
    results: ReadonlyMap<string, BridgeToolResult>,
    suffix: string,
  ): void {
    const pending = [...this.pendingCalls.values()]
    this.pendingCalls.clear()
    if (suffix.length > 0) this.pendingSuffix.push(suffix)
    for (const call of pending) {
      const result = results.get(call.id)
      if (result === undefined) continue
      call.result.resolve(result)
    }
  }

  private async awaitCall(
    call: ParkedCall,
    detachAfterMs: number,
    onDetach: () => void,
    signal: AbortSignal,
    commit?: BridgeCallRequest['commit'],
  ): Promise<BridgeToolResult> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const detach = new Promise<'detach'>((resolve) => {
      timer = setTimeout(() => resolve('detach'), detachAfterMs)
      timer.unref?.()
    })
    let onAbort: (() => void) | undefined
    const aborted = new Promise<'aborted'>((resolve) => {
      if (signal.aborted) resolve('aborted')
      else {
        onAbort = () => resolve('aborted')
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    try {
      const outcome = await Promise.race([call.result.promise, detach, aborted])
      // Check signal.aborted first to close the same-tick Promise.race tie where
      // call.result.promise precedes aborted.
      if (signal.aborted || outcome === 'aborted') {
        return {
          content: [{ type: 'text', text: 'The tool call was cancelled.' }],
          isError: true,
        }
      }
      if (outcome === 'detach') {
        onDetach()
        const detachedResult: BridgeToolResult = {
          content: [
            {
              type: 'text',
              text: 'Tool transport detached while the harness continues execution; the actual result will follow in a new turn.',
            },
          ],
          isError: true,
        }
        return commit !== undefined
          ? commit(() => detachedResult)
          : detachedResult
      }
      return commit !== undefined
        ? commit(() => this.deliverCallResult(outcome))
        : this.deliverCallResult(outcome)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  private consumePendingSuffix(): string {
    if (this.pendingSuffix.length === 0) return ''
    const combined = this.pendingSuffix.join('\n\n')
    this.pendingSuffix.length = 0
    return combined
  }

  /**
   * Finalize one real tool result immediately before returning it over MCP,
   * attaching any deferred harness tool-delta suffix.
   */
  private deliverCallResult(result: BridgeToolResult): BridgeToolResult {
    const suffix = this.consumePendingSuffix()
    if (suffix.length === 0) return result
    return {
      ...result,
      content: [...result.content, { type: 'text', text: `\n\n${suffix}` }],
    }
  }

  /**
   * Route one ACP session update into the event queue.
   * @param update - the agent notification.
   */
  onUpdate(update: AcpSessionUpdate): void {
    if (this.detachState !== 'none' || this.steeringOut) return
    if (
      update.sessionUpdate === 'usage_update' &&
      typeof update.used === 'number' &&
      Number.isFinite(update.used) &&
      update.used > 0
    ) {
      this.contextUsed = update.used
      return
    }
    const content = update.content
    const text = !Array.isArray(content) && content?.type === 'text'
      ? (content.text ?? '')
      : ''
    if (update.sessionUpdate === 'agent_message_chunk' && text.length > 0) {
      this.consumeMessage(text)
      return
    }
    if (update.sessionUpdate === 'agent_thought_chunk') {
      const held = this.recoverNoticeHold()
      if (held.length > 0) this.events.push({ kind: 'text', text: held })
      if (text.length > 0) this.events.push({ kind: 'thought', text })
    }
  }

  /**
   * Keep a message chunk out of the chat while it is only agy's output-cap notice.
   * @param text - one streamed message chunk.
   */
  private consumeMessage(text: string): void {
    const combined = this.noticeHold + text
    if (AGENT_RETRY_NOTICE.test(combined)) {
      this.noticeHold = ''
      this.retryNotices++
      return
    }
    const kind = classifyOutputLimitNotice(combined)
    if (kind === 'hold') {
      this.noticeHold = combined
      return
    }
    this.noticeHold = ''
    if (kind === 'drop') {
      this.retryNotices++
      return
    }
    this.events.push({ kind: 'text', text: combined })
  }

  /**
   * Release a held prefix once the message stream moves on.
   * A finished output-cap notice is counted and discarded; anything else is returned for emission.
   * @returns model text to show, or an empty string.
   */
  recoverNoticeHold(): string {
    if (this.noticeHold.length === 0) return ''
    const held = this.noticeHold
    this.noticeHold = ''
    if (classifyOutputLimitNotice(held) === 'drop') {
      this.retryNotices++
      return ''
    }
    return held
  }

  /**
   * Abandon every parked call with an error result.
   * @param reason - message delivered to the agent.
   */
  abandon(reason: string): void {
    this.terminal ??= { kind: 'cancelled' }
    if (this.terminal.kind === 'cancelled') this.cancellation.abort()
    this.pendingSuffix.length = 0
    this.settleCalls(reason)
  }

  /** End transport ownership without misreporting a process failure as cancellation. */
  fail(error: Error): void {
    this.terminal ??= { kind: 'failed', error }
    this.pendingSuffix.length = 0
    this.events.push({ kind: 'error', error })
    this.settleCalls(error.message)
  }

  /** Guard both async-generator boundaries before emission, accounting, or drain. */
  guard(chunk: StreamChunk | undefined, signal?: AbortSignal): StreamChunk | undefined {
    if (signal?.aborted) this.abandon('The harness cancelled this request.')
    if (this.terminal?.kind === 'failed') throw this.terminal.error
    if (this.terminal?.kind === 'cancelled') return {
      type: 'finish',
      reason: {
        kind: 'aborted',
        failure: { message: 'Request aborted', code: 'ABORTED' },
      },
    }
    return chunk
  }

  private settleCalls(reason: string): void {
    this.releaseSignal?.()
    this.releaseSignal = undefined
    for (const call of this.calls.values()) {
      call.result.resolve({
        content: [{ type: 'text', text: reason }],
        isError: true,
      })
    }
    this.pendingCalls.clear()
  }
}

/** Effects the pump needs from its owner. */
export interface PumpHost {
  /** Window that groups parallel tool calls. */
  parkSettleMs: number
  /** Allowed long-decode continuations. */
  maxContinuations: number
  /** Send one continuation prompt in the same session; resolves with its result. */
  continuePrompt(): Promise<AcpPromptResult>
  /** Request cancellation of the running turn. */
  cancel(): void
}

/** Optional single-call context occupancy inputs for {@link toTokenUsage}. */
export interface TokenUsageOptions {
  /** Latest single-call context occupancy reported via `usage_update.used`. */
  contextTokens?: number
  /** Fallback single-call context occupancy decoded from same-turn `gen_metadata` (`estimated_tokens_used`). */
  estimatedContextTokens?: number
  /** Final `session/prompt` segment's usage when the turn spanned `max_tokens` continuations. */
  lastSegmentUsage?: AcpPromptResult['usage']
}

function accumulateRawUsage(
  prior: AcpPromptResult['usage'],
  next: AcpPromptResult['usage'],
): AcpPromptResult['usage'] {
  if (prior === undefined) return next
  if (next === undefined) return prior
  const add = (a?: number, b?: number): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
  return {
    inputTokens: add(prior.inputTokens, next.inputTokens),
    outputTokens: add(prior.outputTokens, next.outputTokens),
    cachedReadTokens: add(prior.cachedReadTokens, next.cachedReadTokens),
    cachedWriteTokens: add(prior.cachedWriteTokens, next.cachedWriteTokens),
    thoughtTokens: add(prior.thoughtTokens, next.thoughtTokens),
    totalTokens: add(prior.totalTokens, next.totalTokens),
  }
}

/**
 * Map accumulated ACP turn usage into Pi token usage.
 *
 * `totalTokens` feeds Pi's `calculateContextTokens` / ContextMeter / compaction
 * threshold as final-call context occupancy: when `options.contextTokens`
 * (from live `usage_update.used`) is positive, it is used directly; otherwise
 * final-segment prompt buckets are normalized by `calls` and added to final-
 * segment output tokens.
 *
 * Prompt buckets (`inputTokens`, `cacheReadTokens`, `cacheWriteTokens`) are
 * proportionally scaled down whenever their cumulative multi-step sum exceeds
 * `totalTokens`. Pi's `isContextOverflow()` sums `usage.input + usage.cacheRead`
 * directly against `contextWindow` (ignoring `totalTokens`) on `stop` responses,
 * so leaving cumulative multi-step prompt totals unscaled would falsely trigger
 * silent-overflow compaction on long tool-calling turns.
 *
 * `agy acp` reports `inputTokens` as uncached input only, disjoint from
 * `cachedReadTokens` and `cachedWriteTokens`.
 * @param usage - accumulated turn usage.
 * @param calls - model calls inside the final `session/prompt` segment (>= 1).
 * @param options - optional live `usage_update` count and final segment usage.
 * @returns Pi usage.
 */
export function toTokenUsage(
  usage: AcpPromptResult['usage'],
  calls = 1,
  options?: TokenUsageOptions,
): TokenUsage | undefined {
  if (usage === undefined) return undefined
  let input = Math.max(0, Math.round(usage.inputTokens ?? 0))
  let cacheRead = Math.max(0, Math.round(usage.cachedReadTokens ?? 0))
  let cacheWrite = Math.max(0, Math.round(usage.cachedWriteTokens ?? 0))
  const output = Math.max(0, Math.round(usage.outputTokens ?? 0))
  const reasoning =
    usage.thoughtTokens !== undefined && usage.thoughtTokens > 0
      ? Math.min(output, Math.round(usage.thoughtTokens))
      : undefined
  const liveContext = options?.contextTokens
  const estimatedContext = options?.estimatedContextTokens
  let totalTokens: number
  if (
    typeof liveContext === 'number' &&
    Number.isFinite(liveContext) &&
    liveContext > 0
  ) {
    totalTokens = Math.round(liveContext)
  } else if (
    typeof estimatedContext === 'number' &&
    Number.isFinite(estimatedContext) &&
    estimatedContext > 0
  ) {
    totalTokens = Math.round(estimatedContext)
  } else {
    const seg = options?.lastSegmentUsage ?? usage
    const scale = Math.max(1, calls)
    const segPrompt = Math.max(
      0,
      Math.round(
        ((seg.inputTokens ?? 0) +
          (seg.cachedReadTokens ?? 0) +
          (seg.cachedWriteTokens ?? 0)) /
          scale,
      ),
    )
    const segOutput = Math.max(0, Math.round(seg.outputTokens ?? 0))
    totalTokens = segPrompt + segOutput
  }
  const promptSum = input + cacheRead + cacheWrite
  if (promptSum > totalTokens) {
    const rawInput = input
    const rawCacheRead = cacheRead
    const rawCacheWrite = cacheWrite
    const scale = totalTokens / promptSum
    input = Math.floor(rawInput * scale)
    cacheRead = Math.floor(rawCacheRead * scale)
    cacheWrite = Math.floor(rawCacheWrite * scale)
    const remainder = totalTokens - (input + cacheRead + cacheWrite)
    if (remainder > 0) {
      if (rawCacheRead >= rawInput && rawCacheRead >= rawCacheWrite) {
        cacheRead += remainder
      } else if (rawInput >= rawCacheWrite) {
        input += remainder
      } else {
        cacheWrite += remainder
      }
    }
  }
  return {
    inputTokens: input,
    outputTokens: output,
    ...(usage.cachedReadTokens !== undefined || cacheRead > 0
      ? { cacheReadTokens: cacheRead }
      : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning !== undefined && reasoning > 0
      ? { reasoningTokens: reasoning }
      : {}),
    totalTokens,
  }
}

/**
 * Stream one Pi step out of the running turn.
 * @param turn - the running ACP turn.
 * @param host - owner effects.
 * @param signal - Pi cancellation.
 * @yields Pi stream chunks ending with one finish chunk.
 */
export async function* pumpStep(
  turn: AcpTurn,
  host: PumpHost,
  signal: AbortSignal | undefined,
): AsyncGenerator<StreamChunk> {
  const cancel = () => turn.abandon('The harness cancelled this request.')
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  const chunks = stepChunks(turn, host, signal)
  try {
    // Real ACP exit can land behind a queued park, or while a consumer holds block-start.
    for (;;) {
      const interrupted = turn.guard(undefined, signal)
      if (interrupted !== undefined) {
        host.cancel()
        yield interrupted
        return
      }
      const next = await chunks.next()
      const chunk = turn.guard(next.value, signal)
      const aborted = chunk?.type === 'finish' && chunk.reason.kind === 'aborted'
      if (aborted) host.cancel()
      if (chunk !== undefined) yield chunk
      if (aborted) return
      if (next.done) return
    }
  } catch (error) {
    turn.fail(error instanceof Error ? error : new Error(String(error)))
    const interrupted = turn.guard(undefined, signal)
    if (interrupted !== undefined) {
      host.cancel()
      yield interrupted
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    await chunks.return(undefined)
  }
}

async function* stepChunks(
  turn: AcpTurn,
  host: PumpHost,
  signal: AbortSignal | undefined,
): AsyncGenerator<StreamChunk> {
  let index = 0
  let open:
    { index: number; type: 'text' | 'reasoning'; text: string } | undefined
  const close = function* (): Generator<StreamChunk> {
    if (open === undefined) return
    const block: ContentBlock =
      open.type === 'text'
        ? { type: 'text', text: open.text }
        : { type: 'reasoning', text: open.text }
    yield { type: 'block-end', index: open.index, block }
    open = undefined
  }
  const append = function* (
    type: 'text' | 'reasoning',
    text: string,
  ): Generator<StreamChunk> {
    if (open?.type !== type) {
      yield* close()
      open = { index: index++, type, text: '' }
      yield { type: 'block-start', index: open.index, blockType: type }
    }
    open.text += text
    yield type === 'text'
      ? { type: 'text-delta', index: open.index, text }
      : { type: 'reasoning-delta', index: open.index, text }
  }

  turn.stepText = ''
  for (;;) {
    await turn.events.wait(signal)
    if (turn.guard(undefined, signal) !== undefined) return
    if (turn.events.peek()?.kind !== 'text') {
      const held = turn.recoverNoticeHold()
      if (held.length > 0) {
        turn.produced = true
        turn.stepText += held
        yield* append('text', held)
      }
    }
    const event = turn.events.shift() as TurnEvent
    switch (event.kind) {
      case 'thought':
        yield* append('reasoning', event.text)
        break
      case 'text':
        turn.produced = true
        turn.stepText += event.text
        yield* append('text', event.text)
        break
      case 'park': {
        turn.produced = true
        yield* close()
        const batch: ParkedCall[] = [event.call]
        // Parallel calls of one model response arrive within a short window.
        while (await turn.events.wait(signal, host.parkSettleMs)) {
          const next = turn.events.peek()
          if (next?.kind !== 'park') break
          turn.events.shift()
          batch.push(next.call)
        }
        if (turn.guard(undefined, signal) !== undefined) return
        for (const call of batch) {
          const blockIndex = index++
          turn.pendingCalls.set(call.id, call)
          yield {
            type: 'block-start',
            index: blockIndex,
            blockType: 'tool-call',
          }
          yield {
            type: 'tool-call-delta',
            index: blockIndex,
            id: call.id,
            name: call.name,
            argumentsDelta: call.argumentsJson,
          }
          yield {
            type: 'block-end',
            index: blockIndex,
            block: {
              type: 'tool-call',
              id: call.id,
              name: call.name,
              arguments: call.argumentsJson,
            },
          }
        }
        turn.toolSteps++
        turn.segmentToolSteps++
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      case 'done': {
        turn.usage = accumulateRawUsage(turn.usage, event.result.usage)
        const stop = event.result.stopReason
        if (
          stop === 'max_tokens' &&
          turn.continuations < host.maxContinuations
        ) {
          turn.continuations++
          turn.segmentToolSteps = 0
          turn.contextUsed = undefined
          turn.estimatedContextUsed = undefined
          turn.bindPrompt(host.continuePrompt())
          break
        }
        turn.finished = true
        yield* close()
        const segmentCalls =
          event.result.usage !== undefined
            ? turn.segmentToolSteps + 1
            : turn.toolSteps + turn.continuations + 1
        const usage = toTokenUsage(turn.usage, segmentCalls, {
          contextTokens: turn.contextUsed,
          estimatedContextTokens: turn.estimatedContextUsed,
          lastSegmentUsage: event.result.usage ?? turn.usage,
        })
        if (usage !== undefined) yield { type: 'usage', usage }
        if (stop === 'end_turn' && !turn.produced) {
          throw new LlmError(
            'Antigravity ended the turn without visible output',
            'EMPTY_RESPONSE',
          )
        }
        switch (stop) {
          case 'end_turn':
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          case 'max_tokens':
            yield { type: 'finish', reason: { kind: 'max-tokens' } }
            return
          case 'cancelled':
            yield {
              type: 'finish',
              reason: {
                kind: 'aborted',
                failure: {
                  message: 'Antigravity cancelled the turn',
                  code: 'ABORTED',
                },
              },
            }
            return
          case 'refusal':
            yield {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: {
                  message: 'Antigravity refused the request',
                  code: 'REFUSAL',
                },
              },
            }
            return
          default:
            yield {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: {
                  message: `Antigravity stopped: ${stop}`,
                  code: 'PROVIDER_ERROR',
                },
              },
            }
            return
        }
      }
      case 'error':
        turn.finished = true
        turn.fail(event.error)
        turn.guard(undefined, signal)
        return
    }
  }
}

/** Structured MCP metadata the agent reported for one tool call. */
export interface ReportedToolCall {
  kind?: string
  serverName?: string
  toolName?: string
  nativeWritePath?: string
  /** Set when later updates contradicted an already established field. */
  conflict?: boolean
}

/** Read a non-empty string field. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Resolve one explicit metadata field across candidate aliases, flagging when
 * any two non-empty candidates disagree.
 */
function reconcileCandidates(values: readonly unknown[]): {
  value?: string
  conflict: boolean
} {
  let value: string | undefined
  let conflict = false
  for (const raw of values) {
    const candidate = nonEmpty(raw)
    if (candidate === undefined) continue
    if (value === undefined) value = candidate
    else if (value !== candidate) conflict = true
  }
  return { ...(value !== undefined ? { value } : {}), conflict }
}

/**
 * Extract tool identity `(serverName, toolName)` from `session/update`
 * (`recordReportedToolCall`) or `session/request_permission` (`answerPermission`).
 * Reads top-level `mcpServerName`/`mcpToolName` or `_meta`, and reconciles flat
 * `name` (`mcp_<server>_<tool>`). Non-Pi flat names map to a `non-pi:<name>`
 * server sentinel, and contradictions across explicit fields or `name` set
 * `conflict: true`. Returns `{}` only when no identity fields are present.
 * `title` and `rawInput` are deliberately not consulted.
 */
export function structuredToolMeta(
  toolCall: AcpPermissionRequest['toolCall'],
): {
  serverName?: string
  toolName?: string
  conflict?: boolean
} {
  const meta: AcpToolCallMeta | undefined = toolCall?._meta
  const server = reconcileCandidates([
    toolCall?.mcpServerName,
    meta?.mcpServerName,
    meta?.serverName,
    meta?.server,
  ])
  const tool = reconcileCandidates([
    toolCall?.mcpToolName,
    meta?.mcpToolName,
    meta?.toolName,
    meta?.tool,
  ])
  const explicitServer = server.value
  const explicitTool = tool.value
  const flat = nonEmpty(toolCall?.name)
  if (flat === undefined) {
    const conflict = server.conflict || tool.conflict
    return {
      ...(explicitServer !== undefined ? { serverName: explicitServer } : {}),
      ...(explicitTool !== undefined ? { toolName: explicitTool } : {}),
      ...(conflict ? { conflict: true } : {}),
    }
  }
  const candidateServer = explicitServer ?? MCP_SERVER_NAME
  const prefix = `mcp_${candidateServer}_`
  const hasPrefixedTool =
    flat.startsWith(prefix) && flat.length > prefix.length
  const flatServer = hasPrefixedTool ? candidateServer : `non-pi:${flat}`
  const flatTool = hasPrefixedTool ? flat.slice(prefix.length) : flat
  const hasExplicit = explicitServer !== undefined || explicitTool !== undefined
  const conflict =
    server.conflict ||
    tool.conflict ||
    (hasExplicit &&
      (!hasPrefixedTool ||
        (explicitTool !== undefined && explicitTool !== flatTool)))
  return {
    serverName: explicitServer ?? flatServer,
    toolName: explicitTool ?? flatTool,
    ...(conflict ? { conflict: true } : {}),
  }
}

/**
 * Record the structured metadata of one agent-reported tool-call update.
 * The first report establishes the identity; later updates merge only the
 * fields actually present, so a status-only `tool_call_update` never wipes an
 * established `server`/`tool`/`kind`. A later field that contradicts the
 * established identity keeps the original value and marks the record
 * anomalous — the permission gate refuses every further request for that call.
 * @returns 'created' | 'merged' | 'conflict', or undefined for ignored updates.
 */
export function recordReportedToolCall(
  conv: { reportedToolCalls: Map<string, ReportedToolCall> },
  update: AcpSessionUpdate,
  writeTarget?: (update: AcpSessionUpdate, toolName: string) => string | undefined,
): 'created' | 'merged' | 'conflict' | undefined {
  if (
    update.sessionUpdate !== 'tool_call' &&
    update.sessionUpdate !== 'tool_call_update'
  )
    return
  if (typeof update.toolCallId !== 'string' || update.toolCallId.length === 0)
    return
  const {
    serverName,
    toolName,
    conflict: metaConflict,
  } = structuredToolMeta(update)
  const kind = typeof update.kind === 'string' ? update.kind : undefined
  const existing = conv.reportedToolCalls.get(update.toolCallId)
  const merged: ReportedToolCall = existing === undefined ? {} : { ...existing }
  let conflict = metaConflict === true
  if (kind !== undefined) {
    if (merged.kind !== undefined && merged.kind !== kind) conflict = true
    else merged.kind = kind
  }
  if (serverName !== undefined) {
    if (merged.serverName !== undefined && merged.serverName !== serverName)
      conflict = true
    else merged.serverName = serverName
  }
  if (toolName !== undefined) {
    if (merged.toolName !== undefined && merged.toolName !== toolName)
      conflict = true
    else merged.toolName = toolName
  }
  if (
    writeTarget !== undefined &&
    merged.toolName !== undefined &&
    merged.serverName === `non-pi:${merged.toolName}` &&
    update.rawInput !== undefined
  ) {
    const target = writeTarget(update, merged.toolName)
    if (merged.nativeWritePath !== undefined && target !== merged.nativeWritePath)
      conflict = true
    else if (target !== undefined) merged.nativeWritePath = target
  }
  if (conflict) merged.conflict = true
  conv.reportedToolCalls.set(update.toolCallId, merged)
  if (conflict) return 'conflict'
  return existing === undefined ? 'created' : 'merged'
}

/** Whether `rawInput` carries no arguments at all (MCP server loading probes). */
export function isEmptyInput(rawInput: unknown): boolean {
  if (rawInput === undefined || rawInput === null) return true
  if (typeof rawInput === 'string') return rawInput.trim().length === 0
  if (Array.isArray(rawInput)) return rawInput.length === 0
  if (typeof rawInput === 'object') return Object.keys(rawInput).length === 0
  return false
}
