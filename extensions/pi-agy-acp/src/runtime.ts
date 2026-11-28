/**
 * Process, session, and conversation orchestration for the Antigravity ACP
 * provider. One `agy acp` front serves every conversation; each Pi session
 * owns one ACP session whose history
 * advances incrementally, so subagents and the main conversation run
 * concurrently without sharing a turn.
 * @module pi-agy-acp/runtime
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { LlmError } from './protocol.ts'
import type {
  ContentBlock,
  GenerateOptions,
  RequestMessage,
  StreamChunk,
} from './protocol.ts'
import {
  AcpProcess,
  type AcpConfigOption,
  type AcpPermissionOutcome,
  type AcpPermissionRequest,
  type AcpPromptResult,
  type AcpSpawner,
} from './acp-process.ts'
import {
  flattenConfigOptions,
  ModelCatalog,
  nearestEffort,
  resolveAcpModelSelection,
} from './catalog.ts'
import { asEffort, defaults, type Config, type Effort } from './config.ts'
import {
  AcpTurn,
  CALL_TOOL,
  pumpStep,
  type ReportedToolCall,
  structuredToolMeta,
  recordReportedToolCall,
  isEmptyInput,
} from './conversation.ts'
import {
  AGENT_TOOL_PREFIX,
  CALL_TOOL_NAME,
  bridgeSystemPrompt,
  inputPrompt,
  MCP_SERVER_NAME,
  renderTranscript,
  replayPrompt,
  splitSystem,
  toolResultsPrompt,
  type AcpPromptBlock,
} from './history.ts'
import { JsonRpcClosedError, JsonRpcRemoteError } from './jsonrpc.ts'
import {
  McpBridge,
  compactBridgeTool,
  consumeToolDelta,
  toBridgeTools,
  type BridgeCallRequest,
  type BridgeContent,
  type BridgeTool,
  type BridgeToolResult,
} from './mcp-bridge.ts'
import type { NativeWriteActivityRecord } from './native-write-activity.ts'
import { hostWriter, nativeWriteTarget } from './native-writes.ts'
import {
  assertSupportedAgyVersion,
  binaryFingerprint,
  BRIDGE_AGENT,
  defaultAgyHomes,
  defaultHome,
  isDefaultPiAgyHome,
  prepareHome,
  readVersion,
  resolveAgyBinary,
  syncOAuthToken,
  type CommandRunner,
  type PreflightResult,
} from './preflight.ts'
import {
  formatValidationError,
  validateToolArguments,
} from './schema-validate.ts'
import {
  readSessionCursors,
  readSessionTurnData,
  removeSessionArtifacts,
  type HiddenTurnError,
} from './session-db.ts'
import {
  forkConversationDb,
  inspectConversationState,
  readConversationCheckpoint,
  SessionStore,
  type CheckpointMatch,
} from './session-store.ts'
import {
  QuotaReader,
  readLoggedEmail,
  type AccountInfo,
  type QuotaSnapshot,
} from './quota.ts'
import { digest, KeyedMutex, abortable } from './util.ts'
import { VERSION } from './version.ts'

const CONTINUE_PROMPT =
  'Continue exactly where your previous output stopped. Do not repeat any earlier text.'
const SWEEP_INTERVAL_MS = 60_000
const EMAIL_CACHE_TTL_MS = 10_000

/** Host services the runtime uses. */
export interface RuntimeHost {
  config: Config
  spawnAcp: AcpSpawner
  runCommand: CommandRunner
  log: { info(message: string): void; warn(message: string): void }
  /** Notify catalog consumers that the model list changed. */
  onModelsChanged(): void
  /** Report actual agy file activity without inserting a Pi tool call. */
  onNativeWrite?(sessionId: string, activity: NativeWriteActivityRecord): void
  /** Delay before a parked tool call detaches via cancel-and-drain; overrides config.detachAfterMs (140s). */
  detachAfterMs?: number
  /** Maximum ms to wait for `session/cancel` or mid-turn steer acknowledgement; overrides config.cancelTimeoutMs (15s). */
  cancelTimeoutMs?: number
  /** Monotonic clock in milliseconds for quota TTL checks; defaults to `performance.now()`. */
  quotaNow?: () => number
  /** Monotonic clock in milliseconds for idle-session sweeping, LRU ordering, and log-email cache TTL; defaults to `performance.now()`. */
  monotonicNow?: () => number
}

/** Snapshot reported to the settings page and quota pill. */
export interface RuntimeStatus {
  state: 'idle' | 'starting' | 'ready' | 'error'
  error?: string
  binary?: string
  version?: string
  home: string
  account?: AccountInfo
  contextWindow?: number
  defaultEffort: Effort
  models: {
    id: string
    name: string
    efforts: readonly Effort[]
    fixedEffort?: Effort
    contextWindow?: number
  }[]
  efforts: string[]
  liveSessions: number
  activeTurns: number
  lastTurn?: {
    model: string
    effort: string
    steps: number
    outcome: 'completed' | 'aborted' | 'error'
    durationMs: number
    retryNotices: number
    usage?: AcpPromptResult['usage']
    at: string
  }
}

interface Conversation {
  readonly key: string
  tenantKey: string | undefined
  /** Per-tenant bearer credential presented by the agent on the MCP bridge. */
  tenantSecret: string | undefined
  sessionId: string | undefined
  process: AcpProcess | undefined
  configOptions: AcpConfigOption[]
  systemHash: string | undefined
  advertisedTools: BridgeTool[]
  advertisedToolDigests: Map<string, string>
  knownTools: Map<string, string>
  toolNames: Set<string>
  /** Host writer capabilities present in this request before native routing. */
  nativeWriteTools: Set<string>
  /** Full uncompacted tool schemas for MCP boundary argument validation. */
  toolSchemas: Map<string, BridgeTool>
  /** Tool calls the agent reported via `session/update` — the only trusted permission source. */
  reportedToolCalls: Map<string, ReportedToolCall>
  /** True while this conversation is being acquired or its session is opening; never evicted as idle. */
  opening: boolean
  knownIds: string[] | undefined
  issuedIds: Set<string>
  turn: AcpTurn | undefined
  dirty: boolean
  lastUsed: number
  idleMs: number
  /** Logical Pi model family id. */
  model: string | undefined
  /** Exact raw ACP `model` config value currently active (`<model>` or `<model>-<effort>`). */
  acpModelValue: string | undefined
  /** Lower `gen_metadata.idx` bound for `model`, or `null` when unobservable after a failed cursor read. */
  metaFloorIdx: number | null
  /** Last observed SQLite file/sidecar stamp used to skip unchanged reads during streaming. */
  lastDbStamp?: string
  effort: Effort | undefined
}

interface PromptPlan {
  rebuild: boolean
  history: readonly RequestMessage[]
  input: readonly RequestMessage[]
}

/** Owner of the ACP process, the MCP bridge, and every conversation. */
export class AntigravityRuntime {
  readonly bridge: McpBridge
  readonly catalog: ModelCatalog
  readonly quota: QuotaReader
  readonly sessionStore: SessionStore
  private readonly home: string
  private process: AcpProcess | undefined
  private processFingerprint: string | undefined
  private starting: Promise<AcpProcess> | undefined
  private preflight: PreflightResult | undefined
  private preflightFingerprint: string | undefined
  private preflightPromise: Promise<PreflightResult> | undefined
  private state: RuntimeStatus['state'] = 'idle'
  private lastError: string | undefined
  private tierDiscovery: Promise<void> | undefined
  private warmupPromise: Promise<void> | undefined
  private readonly conversations = new Map<string, Conversation>()
  private readonly tenants = new Map<string, Conversation>()
  private readonly mutex = new KeyedMutex()
  /** Serializes capacity checks and session creation so concurrent requests cannot overshoot maxLiveSessions. */
  private readonly capacityMutex = new KeyedMutex()
  private sweeper: ReturnType<typeof setInterval> | undefined
  private readonly monotonicNow: () => number
  private lastSweepAt: number
  /** In-flight `stream()` calls acquiring or using the front process; guards idle teardown. */
  private activeStreams = 0
  /** Monotonic milliseconds the front process has been completely idle. */
  private processIdleMs = 0
  private emailCache:
    | { fingerprint: string; email: string | undefined; at: number }
    | undefined
  private lastTurn: RuntimeStatus['lastTurn']
  private lifecycle: 'active' | 'disposing' | 'disposed' = 'active'
  private readonly shutdown = new AbortController()
  private disposal: Promise<void> | undefined
  private readonly host: RuntimeHost
  private readonly nativeWriteRoot?: string

  /** @param host - host services. */
  constructor(host: RuntimeHost) {
    this.host = host
    this.monotonicNow = host.monotonicNow ?? (() => performance.now())
    this.lastSweepAt = this.monotonicNow()
    const baseHome = host.config.home.length > 0 ? host.config.home : defaultHome()
    const root = host.config.nativeWriteRoot
    if (root !== undefined) {
      if (!isAbsolute(root))
        throw new Error('Native agy writes require an absolute workspace path')
      this.nativeWriteRoot = realpathSync(root)
      if (!statSync(this.nativeWriteRoot).isDirectory())
        throw new Error('Native agy writes require a workspace directory')
    }
    // Don't reuse the bridge-only agent config, permissions, or latched sessions.
    this.home = root === undefined ? baseHome : join(baseHome, 'native-writes')
    this.sessionStore = new SessionStore(this.home)
    this.catalog = new ModelCatalog(
      join(this.home, 'catalog.json'),
      this.currentBinaryFingerprint(),
    )
    this.bridge = new McpBridge(
      {
        listTools: (tenantKey) => this.listTools(tenantKey),
        callTool: (request) => this.callTool(request),
        authorize: (tenantKey, bearerToken) =>
          this.authorizeTenant(tenantKey, bearerToken),
      },
      {
        keepAliveMs: host.config.keepAliveMs,
        log: (message) => host.log.info(message),
      },
    )
    this.quota = new QuotaReader(
      () => resolveAgyBinary(host.config.command),
      host.runCommand,
      host.config.quotaTtlMs,
      host.quotaNow,
    )
  }

  contextWindowFor(model: string): number {
    return this.catalog.contextWindowFor(model)
  }

  maxTokensFor(model: string): number {
    return this.catalog.maxTokensFor(model)
  }

  private currentBinaryFingerprint(binary?: string): string | undefined {
    try {
      return binaryFingerprint(
        binary ?? resolveAgyBinary(this.host.config.command),
      )
    } catch {
      return undefined
    }
  }

  private reconcileBinaryFingerprint(binary?: string): void {
    const fp = this.currentBinaryFingerprint(binary)
    if (fp === undefined) return
    if (
      this.preflight !== undefined &&
      this.preflightFingerprint !== undefined &&
      this.preflightFingerprint !== fp
    ) {
      this.preflight = undefined
      this.preflightFingerprint = undefined
    }
    if (
      this.process?.alive &&
      this.processFingerprint !== undefined &&
      this.processFingerprint !== fp
    ) {
      const canRestart =
        this.starting === undefined &&
        this.warmupPromise === undefined &&
        this.activeStreams === 0 &&
        [...this.conversations.values()].every((c) => this.isIdle(c))
      if (!canRestart) {
        // Defer catalog fingerprint sync while the old binary's process is still active,
        // so live observations from the stale process cannot stamp the new fingerprint.
        return
      }
      // Restart an idle ACP process after an on-disk `agy` upgrade so discovery probes the new binary.
      const stale = this.process
      const staleSessions = [...this.conversations.values()]
        .filter((conv) => conv.process === stale)
        .map((conv) => ({ conv, sessionId: conv.sessionId }))
      this.detachProcess(stale)
      void this.bridge.close()
      for (const { conv, sessionId } of staleSessions) {
        if (sessionId !== undefined) {
          removeSessionArtifacts(this.home, sessionId)
        }
        this.clearSession(conv)
        conv.dirty = true
      }
    }
    if (this.catalog.syncBinaryFingerprint(fp)) {
      this.host.onModelsChanged()
    }
  }

  private harvestSessionTurnData(
    conv: Conversation,
    sessionId: string | undefined,
    model: string | undefined,
    modelFloor: number | null,
    options: {
      turn?: AcpTurn
      lastStepIdx?: number | null
      checkStepsError?: boolean
      ifChangedSince?: string
    } = {},
  ): HiddenTurnError | undefined {
    if (this.lifecycle !== 'active' || !sessionId) return undefined
    const data = readSessionTurnData(this.home, sessionId, {
      metaFloorIdx: model ? modelFloor : null,
      turnMetaFloorIdx: options.turn?.metaFloorIdx ?? null,
      lastStepIdx: options.lastStepIdx,
      checkStepsError: options.checkStepsError,
      ifChangedSince: options.ifChangedSince,
    })
    if (data === undefined) return undefined
    if (conv.sessionId === sessionId) conv.lastDbStamp = data.stamp
    if (data.unchanged) return undefined
    if (options.turn !== undefined && data.estimatedTokensUsed !== undefined) {
      options.turn.estimatedContextUsed = data.estimatedTokensUsed
    }
    return data.hiddenError
  }

  private async runPromptSegment(
    conv: Conversation,
    turn: AcpTurn,
    proc: AcpProcess,
    sessionId: string,
    model: string | undefined,
    modelFloor: number | null,
    blocks: AcpPromptBlock[],
  ): Promise<AcpPromptResult> {
    const cursors = readSessionCursors(this.home, sessionId)
    turn.metaFloorIdx =
      modelFloor === null || cursors === null
        ? null
        : Math.max(modelFloor, cursors.nextMetaIdx)
    turn.lastStepIdx = cursors === null ? null : cursors.lastStepIdx
    turn.estimatedContextUsed = undefined
    let harvested = false
    try {
      const result = await proc.prompt(sessionId, blocks)
      harvested = true
      const checkStepsError =
        result.stopReason === 'end_turn' || result.stopReason === 'refusal'
      const hiddenError = this.harvestSessionTurnData(
        conv,
        sessionId,
        model,
        modelFloor,
        {
          turn,
          lastStepIdx: turn.lastStepIdx,
          checkStepsError,
        },
      )
      if (hiddenError !== undefined) {
        if (hiddenError.dirtySession) conv.dirty = true
        throw new LlmError(hiddenError.message, hiddenError.code)
      }
      return result
    } catch (error) {
      if (!harvested) {
        this.harvestSessionTurnData(conv, sessionId, model, modelFloor, {
          turn,
          checkStepsError: false,
        })
      }
      throw error
    }
  }

  /**
   * Effort one family will actually run at: the nearest offered effort, or the
   * one baked into a fixed-variant id such as `gpt-oss-120b-medium`.
   * @param model - family id.
   * @param requested - effort the caller asked for.
   * @returns the effort to apply.
   */
  effectiveEffort(model: string, requested: Effort): Effort {
    const offered = this.catalog.effortsFor(model)
    if (offered.length > 0) return nearestEffort(requested, offered)
    return this.catalog.fixedEffort(model) ?? requested
  }

  /**
   * Current status for diagnostics surfaces.
   * @param modelId - optional active provider model id.
   * @returns the status snapshot.
   */
  status(modelId?: string): RuntimeStatus {
    const targetModel = modelId ?? this.lastTurn?.model
    const activeContextWindow =
      targetModel !== undefined
        ? this.catalog.contextWindowFor(targetModel)
        : undefined
    return {
      state: this.state,
      ...(this.lastError !== undefined ? { error: this.lastError } : {}),
      ...(this.preflight !== undefined
        ? {
            binary: this.preflight.binary,
            version: this.preflight.version,
          }
        : {}),
      home: this.home,
      account: this.accountInfo(),
      ...(activeContextWindow !== undefined
        ? { contextWindow: activeContextWindow }
        : {}),
      defaultEffort: this.host.config.defaultEffort,
      models: this.catalog.list().map((m) => {
        const contextWindow = this.catalog.contextWindowFor(m.id)
        return {
          ...m,
          efforts: this.catalog.effortsFor(m.id),
          fixedEffort: this.catalog.fixedEffort(m.id),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
        }
      }),
      efforts: [...this.catalog.effortList()],
      liveSessions: [...this.conversations.values()].filter(
        (c) => c.sessionId !== undefined,
      ).length,
      activeTurns: [...this.conversations.values()].filter(
        (c) => c.turn !== undefined && !c.turn.finished,
      ).length,
      ...(this.lastTurn !== undefined ? { lastTurn: this.lastTurn } : {}),
    }
  }

  private accountInfo(): AccountInfo | undefined {
    const paths = [join(this.home, 'acp.log'), this.home]
    if (isDefaultPiAgyHome(this.home))
      paths.push(...defaultAgyHomes())
    const now = this.monotonicNow()
    const fingerprint = logPathsFingerprint(paths)
    let email: string | undefined
    if (
      this.emailCache !== undefined &&
      this.emailCache.fingerprint === fingerprint &&
      now - this.emailCache.at < EMAIL_CACHE_TTL_MS
    ) {
      email = this.emailCache.email
    } else {
      email = readLoggedEmail(paths)
      this.emailCache = { fingerprint, email, at: now }
    }
    const tier = this.catalog.tier()
    if (!email && !tier) return undefined
    return { email, plan: tier?.name, tierId: tier?.id }
  }

  /** Fetch quota and try once per runtime to discover an uncached plan. */
  async readQuota(force = false): Promise<QuotaSnapshot> {
    this.assertActive()
    const quota = this.quota.read(force)
    if (!this.catalog.tier() && !this.catalog.observed) {
      this.tierDiscovery ??= (async () => {
        const state = this.state
        const error = this.lastError
        try {
          await this.warmup({ force: true })
        } catch {
          // Optional account discovery must not leave an otherwise idle runtime in error.
          if (
            (state === 'idle' || state === 'error') &&
            this.state === 'error' &&
            !this.process?.alive &&
            this.conversations.size === 0
          ) {
            this.state = state
            this.lastError = error
          }
        }
      })()
    }
    const [snapshot] = await Promise.all([quota, this.tierDiscovery])
    return { ...snapshot, account: this.accountInfo() }
  }

  /**
   * Run preflight and start the ACP process.
   * @returns the running process.
   */
  async ensureReady(): Promise<AcpProcess> {
    this.assertActive()
    this.processIdleMs = 0
    if (this.sweeper === undefined) {
      this.lastSweepAt = this.monotonicNow()
      this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
      this.sweeper.unref?.()
    }
    if (this.starting === undefined && this.process?.alive === true)
      return this.process
    this.starting ??= this.start().finally(() => {
      this.starting = undefined
    })
    const proc = await this.starting
    this.assertOwner(proc)
    return proc
  }

  /**
   * Refresh the catalog through a tool-less discovery session when uncached,
   * stale for the current `agy` binary, or forced. When this call starts the
   * front process on an otherwise idle runtime, the temporary process and MCP
   * bridge are stopped once discovery finishes unless a stream adopted them.
   * @returns resolves when discovery finished.
   */
  async warmup(
    options: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    this.assertActive()
    options.signal?.throwIfAborted()
    if (this.warmupPromise !== undefined)
      return abortable(this.warmupPromise, options.signal)
    this.reconcileBinaryFingerprint()
    if (!options.force && this.catalog.isCurrent()) return
    const hadProcess =
      this.process?.alive === true || this.starting !== undefined
    this.warmupPromise = (async () => {
      let proc: AcpProcess | undefined
      try {
        proc = await this.ensureReady()
        this.assertOwner(proc)
        const result = await proc
          .newSession(
            {
              cwd: this.preflight?.workspace ?? this.home,
              mcpServers: [],
            },
            { onUpdate: () => undefined },
            120_000,
          )
          .catch((error: unknown) => {
            throw mapError(error)
          })
        try {
          this.assertOwner(proc)
          if (
            this.catalog.observe(
              result.configOptions,
              result.models?.availableModels,
              result._meta?.antigravity?.tier,
            )
          )
            this.host.onModelsChanged()
        } finally {
          await this.closeAndCleanSession(proc, result.sessionId)
        }
      } finally {
        if (!hadProcess && proc !== undefined) {
          await this.stopIdleProcess(proc, { ignoreWarmup: true })
        }
      }
    })().finally(() => {
      this.warmupPromise = undefined
    })
    return abortable(this.warmupPromise, options.signal)
  }

  /** Close conversation sessions while retaining the process and discovery/quota caches. */
  async resetConversations(): Promise<void> {
    this.assertActive()
    this.processIdleMs = 0
    const conversations = [...this.conversations.values()]
    for (const conv of conversations)
      this.dropTurn(conv, 'The Pi session changed.')
    await Promise.all(
      conversations.map(async (conv) => {
        const release = await this.mutex.acquire(conv.key, this.shutdown.signal)
        try {
          if (this.conversations.get(conv.key) !== conv) return
          await this.resetSession(conv)
          this.conversations.delete(conv.key)
        } finally {
          release()
        }
      }),
    )
  }

  /** Stop every session, the process, and the bridge. */
  dispose(options: { purgeArtifacts?: boolean } = {}): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.lifecycle = 'disposing'
    this.shutdown.abort(
      new LlmError('Antigravity provider was disposed', 'TRANSPORT'),
    )
    this.stopSweeper()
    const liveIds: string[] = []
    for (const conv of this.conversations.values()) {
      if (conv.sessionId !== undefined) liveIds.push(conv.sessionId)
      conv.turn?.abandon('The harness provider was unloaded.')
      this.clearSession(conv)
    }
    this.conversations.clear()
    this.tenants.clear()
    this.process?.stop()
    this.process = undefined
    this.processFingerprint = undefined
    if (options.purgeArtifacts === true) {
      for (const id of liveIds) removeSessionArtifacts(this.home, id)
      this.sessionStore.clearAll()
    }
    this.disposal = (async () => {
      // Preflight waits are cancellable; binding must finish before closing its listener.
      await this.starting?.catch(() => undefined)
      await this.warmupPromise?.catch(() => undefined)
      await this.bridge.close()
      this.state = 'idle'
      this.lifecycle = 'disposed'
    })()
    return this.disposal
  }

  private assertActive(): void {
    if (this.lifecycle !== 'active') throw this.shutdown.signal.reason
  }

  /** A captured owner remains usable only while every enclosing owner is current. */
  private owns(proc: AcpProcess, conv?: Conversation, sessionId?: string): boolean {
    return this.lifecycle === 'active' && this.process === proc && proc.alive &&
      (conv === undefined || (
        this.conversations.get(conv.key) === conv &&
        (sessionId === undefined || (conv.process === proc && conv.sessionId === sessionId))
      ))
  }

  private assertOwner(proc: AcpProcess, conv?: Conversation, sessionId?: string): void {
    this.assertActive()
    if (!this.owns(proc, conv, sessionId))
      throw new LlmError('Conversation ownership changed', 'TRANSPORT')
  }

  /**
   * Stream one Pi model step.
   * @param options - the model request.
   * @yields stream chunks.
   */
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (options.signal?.aborted === true) {
      if (options.sessionId !== undefined) this.settleSession(options.sessionId)
      yield {
        type: 'finish',
        reason: {
          kind: 'aborted',
          failure: { message: 'Request aborted', code: 'ABORTED' },
        },
      }
      return
    }
    this.activeStreams++
    this.processIdleMs = 0
    try {
      const proc = await this.ensureReady()
      const key = options.sessionId ?? `anon-${randomBytes(6).toString('hex')}`
      const release = await this.mutex.acquire(key, this.shutdown.signal)
      let conv: Conversation | undefined
      try {
        this.assertActive()
        conv = await this.acquireConversation(key)
        this.assertOwner(proc, conv)
        conv.lastUsed = this.monotonicNow()
        conv.idleMs = 0
        const split = splitSystem(options)
        let tools = toBridgeTools(options.tools)
        if (this.nativeWriteRoot !== undefined) {
          split.system += `\n\nUse native agy file tools instead of Pi edit/write for writes in ${this.nativeWriteRoot}. Use Pi tools for reads.`
          conv.nativeWriteTools = new Set(tools.map((tool) => tool.name))
          tools = tools.filter((tool) => tool.name !== 'edit' && tool.name !== 'write')
        }
        conv.toolNames = new Set(tools.map((t) => t.name))
        conv.toolSchemas = new Map(tools.map((t) => [t.name, t]))
        const requestedEffort =
          asEffort(options.reasoningEffort) ?? this.host.config.defaultEffort
        let effort = this.effectiveEffort(options.model, requestedEffort)

        if (options.signal?.aborted) {
          this.dropTurn(conv, 'The harness cancelled this request.')
          yield {
            type: 'finish',
            reason: {
              kind: 'aborted',
              failure: { message: 'Request aborted', code: 'ABORTED' },
            },
          }
          return
        }
        if (conv.turn !== undefined && conv.turn.pendingCalls.size > 0) {
          // Resuming a parked turn is only valid while the request still starts
          // with the exact history and model/effort selection this ACP session
          // already owns. A compaction checkpoint, pruned/rewritten prefix, or
          // model/effort change means the live session is stale, so abandon the
          // turn and let plan() rebuild from Pi's authoritative history.
          const resolvedPending = resolveAcpModelSelection(
            options.model,
            effort,
            conv.configOptions,
          )
          const resumedEffort =
            resolvedPending?.targetEffort ??
            clampEffortToOptions(conv.configOptions, effort)
          if (
            !this.historyPrefixIntact(conv, split.system, split.messages) ||
            conv.model !== options.model ||
            conv.effort !== resumedEffort
          ) {
            this.dropTurn(
              conv,
              'The conversation history or model selection changed; rebuilding the session from the harness history.',
            )
          } else {
            const resumed = await this.deliverResults(
              conv,
              split.messages,
              proc,
              tools,
            )
            this.assertActive()
            if (resumed !== undefined) {
              conv.knownIds = messageIds(split.messages)
              yield* this.pump(conv, resumed, proc, options, resumedEffort)
              return
            }
            this.dropTurn(
              conv,
              'The conversation history changed; the harness restarted this turn.',
            )
          }
        } else if (conv.turn !== undefined) {
          this.dropTurn(conv, 'Superseded by a newer request.')
        }

        let plan = this.plan(conv, split.system, split.messages)
        if (!plan.rebuild && conv.sessionId !== undefined && conv.knownIds !== undefined) {
          this.pinCompletedTurnCheckpoint(conv, split.messages)
        }
        let supplementalTools: readonly BridgeTool[] = []
        if (plan.rebuild) {
          const systemHash = digest(split.system)
          const match =
            !key.startsWith('anon-') && (proc.supportsResume || proc.supportsLoad)
              ? this.sessionStore.findMatch(
                  systemHash,
                  split.messages,
                  this.host.config.provider,
                  key,
                )
              : undefined
          const resumed =
            match !== undefined
              ? await this.tryResumeOrFork(conv, match, tools, proc, systemHash)
              : false
          if (resumed && match !== undefined) {
            plan = { rebuild: false, history: [], input: match.input }
          } else {
            await this.resetSession(conv)
          }
        }
        this.assertOwner(proc, conv)
        if (conv.sessionId === undefined) {
          conv.systemHash = digest(split.system)
          supplementalTools = await this.openSession(conv, tools, proc)
          effort = this.effectiveEffort(options.model, requestedEffort)
        }
        this.assertOwner(proc, conv, conv.sessionId)
        effort = await this.select(conv, proc, options.model, effort)
        this.assertOwner(proc, conv, conv.sessionId)
        let blocks: AcpPromptBlock[]
        if (plan.rebuild) {
          blocks = replayPrompt(plan.history, plan.input, {
            system: split.system,
            supplementalTools,
            preserveImages: this.catalog.supportsImage(),
          })
        } else {
          blocks = inputPrompt(plan.input)
          const toolDelta = consumeToolDelta(conv, tools)
          if (toolDelta.length > 0)
            blocks.unshift({ type: 'text', text: `${toolDelta}\n\n` })
        }
        if (options.signal?.aborted) {
          this.dropTurn(conv, 'The harness cancelled this request.')
          yield {
            type: 'finish',
            reason: {
              kind: 'aborted',
              failure: { message: 'Request aborted', code: 'ABORTED' },
            },
          }
          return
        }
        conv.knownIds = messageIds(split.messages)
        // A new turn starts with an empty reported-identity space: ids from past
        // turns must never back a fresh permission request.
        conv.reportedToolCalls.clear()
        const turn = conv.turn = new AcpTurn(randomBytes(6).toString('hex'))
        this.startPrompt(conv, turn, proc, blocks)
        yield* this.pump(conv, turn, proc, options, effort)
      } finally {
        try {
          if (conv !== undefined) {
            conv.opening = false
            await this.afterStep(conv)
          }
        } finally {
          release()
        }
      }
    } finally {
      this.activeStreams--
      this.processIdleMs = 0
    }
  }

  /**
   * Acquire one conversation under the capacity gate. When every slot is busy,
   * the oldest idle (non-opening) session is evicted first; if the cap is still
   * reached, the request is rejected immediately instead of queueing, because a
   * waiting subagent and its parent share the same provider route and would
   * deadlock.
   */
  private async acquireConversation(key: string): Promise<Conversation> {
    this.assertActive()
    const existing = this.conversations.get(key)
    if (existing !== undefined) {
      existing.opening = true
      existing.lastUsed = this.monotonicNow()
      existing.idleMs = 0
      return existing
    }
    const unlock = await this.capacityMutex.acquire(
      'capacity',
      this.shutdown.signal,
    )
    try {
      this.assertActive()
      const again = this.conversations.get(key)
      if (again !== undefined) {
        again.opening = true
        again.lastUsed = this.monotonicNow()
        again.idleMs = 0
        return again
      }
      const max = Math.max(1, this.host.config.maxLiveSessions)
      if (this.conversations.size >= max) {
        const idle = [...this.conversations.values()]
          .filter((c) => c.turn === undefined && !c.opening)
          .sort((a, b) => a.lastUsed - b.lastUsed)
        while (this.conversations.size >= max && idle.length > 0) {
          const victim = idle.shift() as Conversation
          this.conversations.delete(victim.key)
          await this.resetSession(victim)
          this.assertActive()
        }
      }
      if (this.conversations.size >= max) {
        throw new LlmError(
          `CAPACITY_EXCEEDED: maxLiveSessions (${max}) reached`,
          'RATE_LIMIT',
        )
      }
      const conv = this.createConversation(key)
      conv.opening = true
      return conv
    } finally {
      unlock()
    }
  }

  private createConversation(key: string): Conversation {
    const conv: Conversation = {
      key,
      tenantKey: undefined,
      tenantSecret: undefined,
      sessionId: undefined,
      process: undefined,
      configOptions: [],
      systemHash: undefined,
      advertisedTools: [],
      advertisedToolDigests: new Map(),
      knownTools: new Map(),
      toolNames: new Set(),
      nativeWriteTools: new Set(),
      toolSchemas: new Map(),
      reportedToolCalls: new Map(),
      opening: false,
      knownIds: undefined,
      issuedIds: new Set(),
      turn: undefined,
      dirty: false,
      lastUsed: this.monotonicNow(),
      idleMs: 0,
      model: undefined,
      acpModelValue: undefined,
      metaFloorIdx: 0,
      effort: undefined,
    }
    this.conversations.set(key, conv)
    return conv
  }

  private async start(): Promise<AcpProcess> {
    this.state = 'starting'
    let proc: AcpProcess | undefined
    try {
      const preflight = await abortable(this.runPreflight(), this.shutdown.signal)
      this.assertActive()
      await this.bridge.start()
      this.assertActive()
      const argv = [
        preflight.binary,
        'acp',
        '--gemini-dir',
        preflight.home,
        '--app-data-dir',
        'agy',
        '--agent',
        BRIDGE_AGENT,
        '--process-per-session',
        '--disable-telemetry',
        '--log-file',
        preflight.logFile,
      ]
      proc = new AcpProcess({
        argv,
        cwd: preflight.workspace,
        spawn: this.host.spawnAcp,
        clientName: 'pi-agy-acp',
        clientVersion: VERSION,
        log: (message) => this.host.log.warn(message),
      })
      this.process = proc
      this.processFingerprint = binaryFingerprint(preflight.binary)
      const started = proc
      proc.onExit((error) => this.onProcessExit(started, error))
      const init = await proc.start(120_000)
      this.assertOwner(proc)
      const agentVersion = init?.agentInfo?.version
      if (typeof agentVersion === 'string' && agentVersion.trim().length > 0) {
        assertSupportedAgyVersion(agentVersion, preflight.binary)
      }
      if (
        this.catalog.observeImageSupport(
          init?.agentCapabilities?.promptCapabilities?.image,
        )
      ) {
        this.host.onModelsChanged()
      }
      this.state = 'ready'
      this.lastError = undefined
      return proc
    } catch (error) {
      proc?.stop()
      if (this.process === proc) {
        this.process = undefined
        this.processFingerprint = undefined
      }
      if (this.lifecycle !== 'active') throw this.shutdown.signal.reason
      await this.bridge.close()
      this.assertActive()
      this.stopSweeper()
      this.state = 'error'
      this.lastError = error instanceof Error ? error.message : String(error)
      throw mapError(error)
    }
  }

  private runPreflight(): Promise<PreflightResult> {
    this.reconcileBinaryFingerprint()
    const warn = (message: string) => this.host.log.warn(message)
    if (this.preflight !== undefined) {
      prepareHome(
        this.home,
        undefined,
        undefined,
        warn,
        this.sessionStore.sessionIds(),
        this.nativeWriteRoot !== undefined,
      )
      return Promise.resolve(this.preflight)
    }
    this.preflightPromise ??= (async () => {
      const config = this.host.config
      const binary = resolveAgyBinary(config.command)
      this.reconcileBinaryFingerprint(binary)
      const version = await readVersion(binary, this.host.runCommand)
      this.assertActive()
      assertSupportedAgyVersion(version, binary)
      const workspace = prepareHome(
        this.home,
        undefined,
        undefined,
        warn,
        this.sessionStore.sessionIds(),
        this.nativeWriteRoot !== undefined,
      )
      const result: PreflightResult = {
        binary,
        version,
        home: this.home,
        workspace,
        logFile: join(this.home, 'acp.log'),
      }
      this.preflight = result
      this.preflightFingerprint = binaryFingerprint(binary)
      return result
    })().finally(() => {
      this.preflightPromise = undefined
    })
    return this.preflightPromise
  }

  private onProcessExit(proc: AcpProcess, error: Error): void {
    const current = this.process === proc
    if (current) {
      this.stopSweeper()
      this.process = undefined
      this.processFingerprint = undefined
      this.processIdleMs = 0
      if (this.starting === undefined) void this.bridge.close()
    }
    if (current && this.lifecycle === 'active') {
      this.state = 'error'
      this.lastError = error.message
      this.host.log.warn(`antigravity-acp: ${error.message}`)
    }
    for (const conv of this.conversations.values()) {
      if (conv.process !== proc) continue
      conv.turn?.fail(new LlmError(
        `Antigravity ACP process exited: ${error.message}`,
        'TRANSPORT',
      ))
      conv.turn = undefined
      this.clearSession(conv)
      conv.dirty = true
    }
  }

  private async openSession(
    conv: Conversation,
    tools: readonly BridgeTool[],
    proc: AcpProcess,
  ): Promise<readonly BridgeTool[]> {
    this.assertOwner(proc, conv)
    try {
      syncOAuthToken(this.home)
    } catch (error) {
      this.host.log.warn(
        `antigravity-acp: OAuth token sync skipped: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    conv.reportedToolCalls.clear()
    const compacted = tools.map(compactBridgeTool)
    const supplementalTools = tools.filter(
      (raw, index) => compacted[index] !== raw,
    )
    conv.advertisedTools = compacted
    conv.advertisedToolDigests = new Map(tools.map((t) => [t.name, digest(t)]))
    conv.knownTools = new Map(conv.advertisedToolDigests)
    const tenantKey = randomBytes(16).toString('hex')
    const tenantSecret = randomBytes(24).toString('hex')
    const mcpServers = [
      {
        type: 'http',
        name: MCP_SERVER_NAME,
        url: `${this.bridge.url}/${tenantKey}`,
        headers: [{ name: 'Authorization', value: `Bearer ${tenantSecret}` }],
      },
    ]
    conv.tenantKey = tenantKey
    conv.tenantSecret = tenantSecret
    this.tenants.set(tenantKey, conv)
    try {
      const result = await proc.newSession(
        {
          cwd: this.nativeWriteRoot ?? this.preflight?.workspace ?? this.home,
          mcpServers,
          _meta: {
            antigravity: {
              systemPrompt: {
                append: bridgeSystemPrompt(this.nativeWriteRoot !== undefined),
              },
            },
          },
        },
        this.createSessionListener(proc, conv, tenantKey),
        120_000,
      )
      // A buffered session/new reply can resolve after its process has exited.
      if (!this.owns(proc, conv)) {
        await this.closeAndCleanSession(proc, result.sessionId)
        this.assertActive()
        throw new LlmError('Conversation ownership changed', 'TRANSPORT')
      }
      conv.sessionId = result.sessionId
      conv.process = proc
      conv.configOptions = result.configOptions ?? []
      conv.model = undefined
      conv.acpModelValue = undefined
      conv.metaFloorIdx = 0
      conv.lastDbStamp = undefined
      conv.effort = undefined

      conv.dirty = false
      conv.issuedIds.clear()
      if (
        this.catalog.observe(
          result.configOptions,
          result.models?.availableModels,
          result._meta?.antigravity?.tier,
        )
      )
        this.host.onModelsChanged()
      return supplementalTools
    } catch (error) {
      this.clearSession(conv)
      throw mapError(error)
    }
  }

  private createSessionListener(
    proc: AcpProcess,
    conv: Conversation,
    tenantKey: string,
  ) {
    const root = this.nativeWriteRoot
    const writeTarget = root === undefined ? undefined : (
      call: import('./acp-process.ts').AcpSessionUpdate,
      name: string,
    ) => hostWriter(name) !== undefined ? nativeWriteTarget(root, call) : undefined
    return {
      onUpdate: (update: import('./acp-process.ts').AcpSessionUpdate) => {
        if (!this.owns(proc, conv) || conv.tenantKey !== tenantKey) return
        if (
          update.sessionUpdate === 'config_option_update' &&
          Array.isArray(update.configOptions)
        ) {
          conv.configOptions = update.configOptions
          if (this.catalog.observe(update.configOptions))
            this.host.onModelsChanged()
        }
        if (recordReportedToolCall(conv, update, writeTarget) === 'conflict') {
          this.host.log.warn(
            `antigravity-acp: agent reported conflicting identity for tool call ${String(update.toolCallId)}`,
          )
        }
        const turn = conv.turn
        if (root !== undefined && turn !== undefined && this.host.onNativeWrite && update.toolCallId !== undefined) {
          const reported = conv.reportedToolCalls.get(update.toolCallId)
          const activity = reported && turn.nativeWriteActivity.observe(update, reported, root)
          if (activity !== undefined) {
            try {
              this.host.onNativeWrite(conv.key, activity)
            } catch (error) {
              this.host.log.warn(`antigravity-acp: could not record native write: ${String(error)}`)
            }
          }
        }
        turn?.onUpdate(update)
        if (update.sessionUpdate === 'usage_update') {
          const hasPositiveUsed =
            typeof update.used === 'number' &&
            Number.isFinite(update.used) &&
            update.used > 0
          if (!hasPositiveUsed) {
            this.harvestSessionTurnData(
              conv,
              conv.sessionId,
              conv.model,
              conv.metaFloorIdx,
              {
                turn: conv.turn,
                ifChangedSince: conv.lastDbStamp,
              },
            )
          }
        }
      },
      onPermission: (request: AcpPermissionRequest) =>
        this.owns(proc, conv) && conv.tenantKey === tenantKey
          ? this.answerPermission(conv, request)
          : ({ outcome: 'cancelled' } as AcpPermissionOutcome),
    }
  }

  /**
   * Attempt native `session/resume` (or `VACUUM INTO` copy-on-rewind fork +
   * `session/resume`, falling back to `session/load`) from a verified checkpoint.
   * Returns `true` when the session is mounted and ready for incremental input;
   * returns `false` on any mismatch or error so the caller falls back cleanly to
   * `<pi_history>` replay.
   */
  private async tryResumeOrFork(
    conv: Conversation,
    match: CheckpointMatch,
    tools: readonly BridgeTool[],
    proc: AcpProcess,
    systemHash: string,
  ): Promise<boolean> {
    const cp = match.checkpoint
    const state = inspectConversationState(
      this.home,
      cp.agySessionId,
      cp.marks,
      cp.dbFingerprint,
    )
    if (state === 'mismatch') {
      this.sessionStore.forgetSession(cp.agySessionId)
      return false
    }

    // Close any currently open ACP session on this conversation while keeping
    // checkpointed DB files intact on disk.
    await this.resetSession(conv)
    this.assertOwner(proc, conv)

    let targetSessionId = cp.agySessionId
    let createdForkId: string | undefined
    if (state === 'ahead') {
      const forkId = forkConversationDb(
        this.home,
        cp.agySessionId,
        cp.marks,
        cp.dbFingerprint,
      )
      if (forkId === undefined) return false
      targetSessionId = forkId
      createdForkId = forkId
    }

    try {
      syncOAuthToken(this.home)
    } catch {
      // Best-effort OAuth sync.
    }

    conv.reportedToolCalls.clear()
    const compacted = tools.map(compactBridgeTool)
    conv.advertisedTools = compacted
    conv.advertisedToolDigests = new Map(tools.map((t) => [t.name, digest(t)]))
    // Seed knownTools from the checkpoint so consumeToolDelta emits only tools
    // that changed, were added, or were disabled since the checkpoint.
    conv.knownTools = new Map(Object.entries(cp.knownTools))

    const tenantKey = randomBytes(16).toString('hex')
    const tenantSecret = randomBytes(24).toString('hex')
    const mcpServers = [
      {
        type: 'http',
        name: MCP_SERVER_NAME,
        url: `${this.bridge.url}/${tenantKey}`,
        headers: [{ name: 'Authorization', value: `Bearer ${tenantSecret}` }],
      },
    ]
    conv.tenantKey = tenantKey
    conv.tenantSecret = tenantSecret
    this.tenants.set(tenantKey, conv)

    const sessionParams = {
      cwd: this.nativeWriteRoot ?? this.preflight?.workspace ?? this.home,
      mcpServers,
      _meta: {
        antigravity: {
          systemPrompt: {
            append: bridgeSystemPrompt(this.nativeWriteRoot !== undefined),
          },
        },
      },
    }
    const listener = this.createSessionListener(proc, conv, tenantKey)

    try {
      let result: import('./acp-process.ts').AcpNewSessionResult
      if (proc.supportsResume) {
        try {
          result = await proc.resumeSession(
            targetSessionId,
            sessionParams,
            listener,
            120_000,
          )
        } catch (resumeError) {
          if (!proc.supportsLoad) throw resumeError
          result = await proc.loadSession(
            targetSessionId,
            sessionParams,
            listener,
            120_000,
          )
        }
      } else {
        result = await proc.loadSession(
          targetSessionId,
          sessionParams,
          listener,
          120_000,
        )
      }

      if (!this.owns(proc, conv)) {
        await proc.closeSession(result.sessionId)
        if (createdForkId !== undefined) {
          removeSessionArtifacts(this.home, createdForkId)
        }
        this.assertActive()
        return false
      }

      conv.sessionId = result.sessionId
      conv.process = proc
      conv.configOptions = result.configOptions ?? []
      conv.systemHash = systemHash
      conv.knownIds = [...match.completedIds]
      conv.issuedIds = new Set(cp.issuedIds)
      conv.model = undefined
      conv.acpModelValue = undefined
      const cursors = readSessionCursors(this.home, result.sessionId)
      conv.metaFloorIdx = cursors?.nextMetaIdx ?? 0
      conv.lastDbStamp = undefined
      conv.effort = undefined
      conv.dirty = false

      this.sessionStore.pinCompletedIds(
        cp.agySessionId,
        cp.knownIds,
        match.completedIds,
      )
      if (createdForkId !== undefined) {
        this.sessionStore.record({
          ...cp,
          agySessionId: createdForkId,
          piSessionKey: conv.key,
          completedIds: [...match.completedIds],
          updatedAt: Date.now(),
        })
      }

      if (
        this.catalog.observe(
          result.configOptions,
          result.models?.availableModels,
          result._meta?.antigravity?.tier,
        )
      ) {
        this.host.onModelsChanged()
      }
      return true
    } catch (error) {
      this.host.log.warn(
        `antigravity-acp: native session resume/fork failed, falling back to replay: ${error instanceof Error ? error.message : String(error)}`,
      )
      this.clearSession(conv)
      if (createdForkId !== undefined) {
        removeSessionArtifacts(this.home, createdForkId)
      }
      return false
    }
  }

  /** Pin the exact assistant message id onto the previous turn's checkpoint once Pi passes it back. */
  private pinCompletedTurnCheckpoint(
    conv: Conversation,
    messages: readonly RequestMessage[],
  ): void {
    if (conv.sessionId === undefined || conv.knownIds === undefined) return
    const idx = conv.knownIds.length
    const next = messages[idx]
    if (
      next?.role === 'assistant' &&
      next.source.kind === 'model' &&
      next.source.provider === this.host.config.provider &&
      next.id !== undefined
    ) {
      this.sessionStore.pinCompletedIds(conv.sessionId, conv.knownIds, [
        ...conv.knownIds,
        next.id,
      ])
    }
  }

  /** Record a verified SQLite checkpoint after a clean turn completion. */
  private recordTurnCheckpoint(conv: Conversation, turn: AcpTurn): void {
    if (
      conv.key.startsWith('anon-') ||
      conv.dirty ||
      conv.sessionId === undefined ||
      conv.systemHash === undefined ||
      conv.knownIds === undefined ||
      conv.knownIds.length === 0
    ) {
      return
    }
    const snap = readConversationCheckpoint(this.home, conv.sessionId)
    if (snap === undefined) return
    this.sessionStore.record({
      agySessionId: conv.sessionId,
      piSessionKey: conv.key,
      systemHash: conv.systemHash,
      knownIds: [...conv.knownIds],
      finalTextHash: digest(turn.stepText),
      issuedIds: [...conv.issuedIds],
      advertisedToolDigests: Object.fromEntries(conv.advertisedToolDigests),
      knownTools: Object.fromEntries(conv.knownTools),
      marks: snap.marks,
      dbFingerprint: snap.dbFingerprint,
      ...(conv.model !== undefined ? { model: conv.model } : {}),
      ...(conv.effort !== undefined ? { effort: conv.effort } : {}),
      updatedAt: Date.now(),
    })
  }

  /** Constant-time check of one tenant's current bearer credential. */
  private authorizeTenant(
    tenantKey: string | undefined,
    bearerToken: string | undefined,
  ): boolean {
    if (tenantKey === undefined || bearerToken === undefined) return false
    const secret = this.tenants.get(tenantKey)?.tenantSecret
    if (secret === undefined) return false
    const left = Buffer.from(bearerToken, 'utf8')
    const right = Buffer.from(secret, 'utf8')
    if (left.length !== right.length) {
      timingSafeEqual(left, left)
      return false
    }
    return timingSafeEqual(left, right)
  }

  /** Drop one conversation's tenant registration together with its bridge handshake evidence. */
  private releaseTenant(conv: Conversation): void {
    if (conv.tenantKey === undefined) return
    this.tenants.delete(conv.tenantKey)
    this.bridge.forgetTenant(conv.tenantKey)
  }

  /**
   * Decide one `session/request_permission` from structured host-reported
   * metadata only. `title` and `rawInput` are never matched against tool
   * names: a native tool whose payload merely contains `mcp_pi_…` or a
   * spoofed title must not unlock the bridge.
   */
  private answerPermission(
    conv: Conversation,
    request: AcpPermissionRequest,
  ): AcpPermissionOutcome {
    const pick = (kind: string): AcpPermissionOutcome | undefined => {
      const option = request.options.find((o) => o.kind === kind)
      return option === undefined
        ? undefined
        : { outcome: 'selected', optionId: option.optionId }
    }
    const reject = (reason: string): AcpPermissionOutcome => {
      this.host.log.warn(
        `antigravity-acp: refused permission request (${reason}): ${request.toolCall?.title || request.toolCall?.name || 'unknown'}`,
      )
      return pick('reject_once') ?? { outcome: 'cancelled' }
    }
    if (conv.sessionId === undefined || request.sessionId !== conv.sessionId)
      return reject('session mismatch')
    if (conv.tenantKey === undefined)
      return reject('no MCP bridge is mounted for this session')
    if (conv.turn === undefined || conv.turn.finished)
      return reject('no live turn')
    const toolCallId = request.toolCall?.toolCallId
    if (typeof toolCallId !== 'string' || toolCallId.length === 0)
      return reject('missing toolCallId')
    const reported = conv.reportedToolCalls.get(toolCallId)
    const claimed = structuredToolMeta(request.toolCall)
    if (claimed.conflict === true) {
      return reject('conflicting tool metadata in permission request')
    }
    if (reported === undefined) {
      // Nothing the agent reported in `session/update` backs this call: its own
      // in-request metadata is untrusted (stale or cross-session toolCallId).
      if (claimed.serverName !== undefined || claimed.toolName !== undefined) {
        return reject(`tool call ${toolCallId} was never reported by the agent`)
      }
      // The only identity-less exception is the agent's MCP loading probe
      // (no tool name, no input), and it must be bound to explicit evidence:
      // this tenant itself completed the MCP handshake with its bearer secret.
      // Even then the probe is never granted `allow_always`.
      if (
        request.toolCall?.kind === 'other' &&
        isEmptyInput(request.toolCall.rawInput)
      ) {
        if (!this.bridge.hasHandshake(conv.tenantKey)) {
          return reject('identity-less probe without a completed MCP handshake')
        }
        return pick('allow_once') ?? { outcome: 'cancelled' }
      }
      return reject('missing structured tool metadata')
    }
    if (reported.conflict === true) {
      return reject(
        `reported identity of tool call ${toolCallId} conflicts across agent updates`,
      )
    }
    if (
      claimed.serverName !== undefined &&
      claimed.serverName !== reported.serverName
    )
      return reject('MCP server name conflict')
    if (
      claimed.toolName !== undefined &&
      claimed.toolName !== reported.toolName
    )
      return reject('tool name conflict')
    const root = this.nativeWriteRoot
    const name = request.toolCall?.name
    const writer = hostWriter(name)
    if (
      root !== undefined && writer !== undefined &&
      reported.serverName === `non-pi:${name}`
    ) {
      if (request.toolCall?.kind !== 'edit' || reported.kind !== 'edit')
        return reject('native writer kind is not edit')
      if (!conv.nativeWriteTools.has(writer))
        return reject(`Pi ${writer} was not enabled for this request`)
      const target = nativeWriteTarget(root, request.toolCall)
      if (target === undefined || target !== reported.nativeWritePath)
        return reject('native write target is ambiguous, disagrees with the report, or is outside the workspace')
      return pick('allow_once') ?? { outcome: 'cancelled' }
    }
    if (reported.serverName !== MCP_SERVER_NAME)
      return reject(`unknown MCP server ${reported.serverName ?? '(none)'}`)
    const isAllowedTool =
      reported.toolName !== undefined &&
      (conv.advertisedToolDigests.has(reported.toolName) ||
        reported.toolName === CALL_TOOL_NAME)
    if (!isAllowedTool) {
      return reject(
        `tool is not offered to this session: ${reported.toolName ?? '(none)'}`,
      )
    }
    return pick('allow_once') ?? { outcome: 'cancelled' }
  }

  private async select(
    conv: Conversation,
    proc: AcpProcess,
    model: string,
    effort: Effort,
  ): Promise<Effort> {
    const sessionId = conv.sessionId as string
    this.assertOwner(proc, conv, sessionId)
    const modelOption = conv.configOptions.find(
      (o) => o.id === 'model' || o.category === 'model',
    )
    const resolved = resolveAcpModelSelection(model, effort, conv.configOptions)
    if (resolved === undefined) {
      const available =
        modelOption?.options !== undefined
          ? flattenConfigOptions(modelOption.options).map((o) => o.value)
          : []
      throw new LlmError(
        `Antigravity does not offer model "${model}" to this account; available: ${available.join(', ')}`,
        'UNKNOWN_MODEL',
      )
    }
    const previousModel = conv.model
    const previousFloor = conv.metaFloorIdx
    if (previousModel !== undefined && previousModel !== model) {
      this.harvestSessionTurnData(conv, sessionId, previousModel, previousFloor)
      conv.metaFloorIdx = null
      conv.lastDbStamp = undefined
    }
    if (
      conv.acpModelValue !== resolved.acpModelValue &&
      modelOption?.currentValue !== resolved.acpModelValue
    ) {
      await this.applyConfigOption(
        conv,
        proc,
        sessionId,
        modelOption?.id ?? 'model',
        resolved.acpModelValue,
      )
    }
    if (previousModel !== undefined && previousModel !== model) {
      const cursors = readSessionCursors(this.home, sessionId)
      conv.metaFloorIdx =
        previousFloor === null || cursors === null
          ? null
          : Math.max(previousFloor, cursors.nextMetaIdx)
      conv.lastDbStamp = undefined
    }
    conv.model = model
    conv.acpModelValue = resolved.acpModelValue
    // Re-read levelOption after any model switch because `configOptions` may update.
    const levelOption = conv.configOptions.find(
      (o) => o.id === 'thought_level' || o.category === 'thought_level',
    )
    const offeredEfforts =
      levelOption?.options !== undefined
        ? flattenConfigOptions(levelOption.options)
            .map((o) => asEffort(o.value))
            .filter((v): v is Effort => v !== undefined)
        : undefined
    const targetEffort = resolved.usesSuffixedModel
      ? resolved.targetEffort
      : offeredEfforts !== undefined && offeredEfforts.length > 0
        ? offeredEfforts.includes(effort)
          ? effort
          : nearestEffort(effort, offeredEfforts)
        : effort
    // Effort-suffixed model IDs already pin thought_level; fixed-variant families
    // reject thought_level writes. Only write thought_level for bare selectable models.
    if (
      !resolved.usesSuffixedModel &&
      this.catalog.supportsEffortSelection(model) &&
      levelOption !== undefined &&
      (offeredEfforts === undefined || offeredEfforts.length > 0) &&
      conv.effort !== targetEffort &&
      levelOption.currentValue !== targetEffort
    ) {
      await this.applyConfigOption(
        conv,
        proc,
        sessionId,
        levelOption.id,
        targetEffort,
      )
    }
    conv.effort = targetEffort
    return targetEffort
  }

  private async applyConfigOption(
    conv: Conversation,
    proc: AcpProcess,
    sessionId: string,
    optionId: string,
    value: string,
  ): Promise<void> {
    const configOptions = await proc
      .setConfigOption(sessionId, optionId, value)
      .catch((error: unknown) => {
        throw mapError(error)
      })
    this.assertOwner(proc, conv, sessionId)
    conv.configOptions = configOptions
    if (this.catalog.observe(configOptions)) {
      this.host.onModelsChanged()
    }
  }

  private plan(
    conv: Conversation,
    system: string,
    messages: readonly RequestMessage[],
  ): PromptPlan {
    const reusable =
      conv.sessionId !== undefined &&
      !conv.dirty &&
      this.historyPrefixIntact(conv, system, messages)
    if (reusable) {
      const known = conv.knownIds as string[]
      let rest = messages.slice(known.length)
      let skip = 0
      while (
        skip < rest.length &&
        this.isOwn(conv, rest[skip] as RequestMessage)
      )
        skip++
      rest = rest.slice(skip)
      if (
        rest.length > 0 &&
        rest.every((m) => m.role === 'user' || m.role === 'system')
      ) {
        return { rebuild: false, history: [], input: rest }
      }
    }
    let cut = messages.length
    while (cut > 0) {
      const role = messages[cut - 1]?.role
      if (role !== 'user' && role !== 'system') break
      cut--
    }
    return {
      rebuild: true,
      history: messages.slice(0, cut),
      input: messages.slice(cut),
    }
  }

  /**
   * Whether the live ACP session's context is still an exact prefix of the
   * request: the same system prompt and the same message ids in the same order.
   * A compaction checkpoint, a pruned/rewritten prefix, or a replaced system
   * prompt all make the session stale and force a rebuild.
   * @param conv - conversation owning the ACP session.
   * @param system - current Pi system prompt.
   * @param messages - full request history after leading system messages.
   * @returns true when only new messages were appended.
   */
  private historyPrefixIntact(
    conv: Conversation,
    system: string,
    messages: readonly RequestMessage[],
  ): boolean {
    // plan() has always required the same system digest for reuse; a changed
    // digest is a genuinely new prompt, while mid-conversation updates travel
    // as `system` messages inside `messages` (systemPromptUpdate: 'in-history').
    if (conv.knownIds === undefined || conv.systemHash !== digest(system))
      return false
    const known = conv.knownIds
    return (
      known.length <= messages.length &&
      known.every((id, index) => messages[index]?.id === id)
    )
  }

  private isOwn(conv: Conversation, message: RequestMessage): boolean {
    if (message.role === 'assistant')
      return (
        message.source.kind === 'model' &&
        message.source.provider === this.host.config.provider
      )
    if (message.role === 'tool') return conv.issuedIds.has(message.toolCallId)
    return false
  }

  private async closeAndCleanSession(
    proc: AcpProcess,
    sessionId: string,
  ): Promise<void> {
    try {
      await proc.closeSession(sessionId)
    } finally {
      removeSessionArtifacts(this.home, sessionId)
    }
  }

  private async resetSession(
    conv: Conversation,
    options: { purgeArtifacts?: boolean } = {},
  ): Promise<void> {
    this.harvestSessionTurnData(conv, conv.sessionId, conv.model, conv.metaFloorIdx, {
      ifChangedSince: conv.lastDbStamp,
    })
    let closing: Promise<void> | undefined
    if (conv.sessionId !== undefined && conv.process !== undefined) {
      const preserve =
        options.purgeArtifacts !== true &&
        !conv.key.startsWith('anon-') &&
        this.sessionStore.hasSession(conv.sessionId)
      closing = preserve
        ? conv.process.closeSession(conv.sessionId)
        : this.closeAndCleanSession(conv.process, conv.sessionId)
    }
    this.clearSession(conv)
    conv.knownIds = undefined
    conv.dirty = false
    await closing
  }

  private clearSession(conv: Conversation): void {
    this.releaseTenant(conv)
    conv.sessionId = undefined
    conv.tenantKey = undefined
    conv.tenantSecret = undefined
    conv.process = undefined
    conv.acpModelValue = undefined
    conv.metaFloorIdx = null
    conv.lastDbStamp = undefined
    conv.advertisedTools = []
    conv.advertisedToolDigests.clear()
    conv.knownTools.clear()
    conv.reportedToolCalls.clear()
  }

  private startPrompt(
    conv: Conversation,
    turn: AcpTurn,
    proc: AcpProcess,
    blocks: AcpPromptBlock[],
  ): void {
    // AcpProcess.prompt's link() can throw before returning a promise (buffered reply + exit).
    // Queue that failure too, so every allocated turn reaches the pump's cleanup owner.
    try {
      this.assertOwner(proc, conv, conv.sessionId)
      const sessionId = conv.sessionId as string
      const model = conv.model
      const modelFloor = conv.metaFloorIdx
      turn.bindPrompt(
        this.runPromptSegment(
          conv,
          turn,
          proc,
          sessionId,
          model,
          modelFloor,
          blocks,
        ),
        { mapError },
      )
    } catch (error) {
      turn.fail(mapError(error))
    }
  }

  private async *pump(
    conv: Conversation,
    turn: AcpTurn,
    proc: AcpProcess,
    options: GenerateOptions,
    effort: Effort,
  ): AsyncGenerator<StreamChunk> {
    const sessionId = conv.sessionId as string
    const metaFloorIdx = conv.metaFloorIdx
    let finishKind: string | undefined
    let drained = false
    const cancel = () => {
      if (conv.turn === turn)
        this.dropTurn(conv, 'The harness cancelled this request.')
    }
    // Pi 1.5.2 pi-agent-core/dist/agent-loop.js shares this signal with tool execution.
    turn.releaseSignal?.()
    turn.releaseSignal = undefined
    if (options.signal !== undefined) {
      const signal = options.signal
      signal.addEventListener('abort', cancel, { once: true })
      turn.releaseSignal = () => {
        signal.removeEventListener('abort', cancel)
      }
      if (signal.aborted) cancel()
    }
    const signal = options.signal === undefined
      ? turn.cancellation.signal
      : AbortSignal.any([options.signal, turn.cancellation.signal])
    const recordTurn = (
      outcome: NonNullable<RuntimeStatus['lastTurn']>['outcome'],
    ) => {
      this.lastTurn = {
        model: options.model,
        effort,
        steps: turn.toolSteps + turn.continuations + 1,
        usage: turn.usage,
        outcome,
        durationMs: Math.max(0, performance.now() - turn.startedAt),
        retryNotices: turn.retryNotices,
        at: new Date().toISOString(),
      }
    }
    try {
      for await (const emitted of pumpStep(
        turn,
        {
          parkSettleMs: this.host.config.parkSettleMs,
          maxContinuations: this.host.config.longDecodeContinuations,
          continuePrompt: () =>
            this.runPromptSegment(
              conv,
              turn,
              proc,
              sessionId,
              options.model,
              metaFloorIdx,
              [{ type: 'text', text: CONTINUE_PROMPT }],
            ),
          cancel: () => {
            if (conv.turn === turn) proc.cancel(sessionId)
          },
        },
        signal,
      )) {
        // for-await adds a microtask boundary after pumpStep's own emission guard.
        const chunk = turn.guard(emitted, signal) as StreamChunk
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call')
          conv.issuedIds.add(chunk.block.id)
        if (chunk.type === 'finish') {
          finishKind = chunk.reason.kind
          if (finishKind === 'aborted') {
            this.harvestSessionTurnData(conv, sessionId, options.model, metaFloorIdx, {
              ifChangedSince: conv.lastDbStamp,
            })
          }
        }
        yield chunk
        if (chunk.type === 'finish' && chunk.reason.kind === 'aborted') break
      }
      const interrupted = turn.guard(undefined, signal)
      if (interrupted !== undefined && finishKind !== 'aborted') {
        finishKind = 'aborted'
        this.harvestSessionTurnData(conv, sessionId, options.model, metaFloorIdx, {
          ifChangedSince: conv.lastDbStamp,
        })
        yield interrupted
      }
      drained = true
    } catch (error) {
      finishKind = 'error'
      this.harvestSessionTurnData(conv, sessionId, options.model, metaFloorIdx, {
        ifChangedSince: conv.lastDbStamp,
      })
      throw mapError(error)
    } finally {
      // Only a fully consumed tool handoff keeps the turn and its cancellation owner.
      if (!(drained && finishKind === 'tool-calls' && !signal.aborted && conv.turn === turn)) {
        recordTurn(
          finishKind === 'error' ? 'error' : signal.aborted ? 'aborted'
            : !drained ? 'error' : 'completed',
        )
        if (conv.turn === turn) {
          if (!drained || finishKind === 'aborted' || finishKind === 'error')
            this.dropTurn(conv, 'The harness ended this request.')
          else {
            if (finishKind === 'stop' || finishKind === 'max-tokens') {
              this.recordTurnCheckpoint(conv, turn)
            }
            turn.abandon('The turn completed.')
            conv.reportedToolCalls.clear()
            conv.turn = undefined
          }
        }
        if (finishKind === 'aborted' || !drained) {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              turn.promptSettled,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 5_000)
              }),
            ])
          } finally {
            clearTimeout(timer)
          }
        }
      }
    }
  }

  private async deliverResults(
    conv: Conversation,
    messages: readonly RequestMessage[],
    proc: AcpProcess,
    tools: readonly BridgeTool[],
  ): Promise<AcpTurn | undefined> {
    this.assertOwner(proc, conv, conv.sessionId)
    const turn = conv.turn as AcpTurn
    const results = new Map<string, Extract<RequestMessage, { role: 'tool' }>>()
    let last = -1
    messages.forEach((message, index) => {
      if (
        message.role === 'tool' &&
        turn.pendingCalls.has(message.toolCallId)
      ) {
        results.set(message.toolCallId, message)
        last = Math.max(last, index)
      }
    })
    if (results.size !== turn.pendingCalls.size) return undefined
    const extras = messages.slice(last + 1)
    if (extras.some((m) => m.role === 'assistant' || m.role === 'tool'))
      return undefined

    // Wait for any in-flight cancel-and-drain detach to finish before resuming.
    if (turn.detachDrain !== undefined) {
      await turn.detachDrain
      this.assertOwner(proc, conv, conv.sessionId)
      if (turn.detachFailed) return undefined
    }

    const toolDelta = consumeToolDelta(conv, tools)
    const bridgeResults = new Map<string, BridgeToolResult>()
    for (const [id, message] of results) {
      bridgeResults.set(
        id,
        this.toBridgeResult(message.content, message.isError === true),
      )
    }

    // Branch A: The ACP prompt settled or was detached via cancel-and-drain;
    // deliver the real tool results (preserving native images) + any steer in a fresh turn.
    if (!turn.isPromptActive || turn.isDetachingOrDetached) {
      const delivery = turn.deliverToolResults(bridgeResults, toolDelta)
      if (delivery.resumed) return turn
      const orderedResults = delivery.pending
        .map((call) => results.get(call.id))
        .filter(
          (msg): msg is Extract<RequestMessage, { role: 'tool' }> =>
            msg !== undefined,
        )
      turn.abandon('The agent ended or detached the tool-waiting prompt.')
      conv.reportedToolCalls.clear()
      const next = (conv.turn = new AcpTurn(randomBytes(6).toString('hex')))
      this.startPrompt(
        conv,
        next,
        proc,
        toolResultsPrompt(orderedResults, {
          suffix: delivery.suffix,
          extras,
          preserveImages: this.catalog.supportsImage(),
        }),
      )
      return next
    }

    // Branch B: Native mid-turn steering (`steersWithPrompt` on agy >= 1.5.0) when
    // trailing user steer messages arrive alongside tool results for a parked turn.
    const hasUserSteer = extras.some((m) => m.role === 'user')
    if (hasUserSteer && proc.supportsPromptSteering) {
      const cancelTimeoutMs =
        this.host.cancelTimeoutMs ??
        this.host.config.cancelTimeoutMs ??
        defaults.cancelTimeoutMs
      turn.steeringOut = true
      const next = new AcpTurn(randomBytes(6).toString('hex'))
      conv.turn = next
      this.startPrompt(conv, next, proc, inputPrompt(extras))
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const outcome = await Promise.race([
          turn.promptSettled.then(() => 'accepted' as const),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(
              () => resolve('timeout'),
              Math.max(100, cancelTimeoutMs),
            )
            timer.unref?.()
          }),
        ])
        if (outcome === 'timeout') {
          turn.abandon('Antigravity did not accept mid-turn steer in time.')
          return undefined
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      this.assertOwner(proc, conv, conv.sessionId)
      turn.resolveParkedForSteer(bridgeResults, toolDelta)
      return next
    }

    // Branch C: Normal fast path — resolve parked MCP calls in-place on the live turn.
    const extraText = extras.length > 0 ? renderTranscript(extras) : ''
    const suffix = [toolDelta, extraText].filter(Boolean).join('\n\n')
    const delivery = turn.deliverToolResults(bridgeResults, suffix)
    if (!delivery.resumed) {
      const orderedResults = delivery.pending
        .map((call) => results.get(call.id))
        .filter(
          (msg): msg is Extract<RequestMessage, { role: 'tool' }> =>
            msg !== undefined,
        )
      turn.abandon('The agent ended the tool-waiting prompt.')
      conv.reportedToolCalls.clear()
      const next = (conv.turn = new AcpTurn(randomBytes(6).toString('hex')))
      this.startPrompt(
        conv,
        next,
        proc,
        toolResultsPrompt(orderedResults, {
          suffix: delivery.suffix,
          extras,
          preserveImages: this.catalog.supportsImage(),
        }),
      )
      return next
    }
    return turn
  }

  private toBridgeResult(
    content: readonly ContentBlock[],
    isError: boolean,
  ): BridgeToolResult {
    const items: BridgeContent[] = []
    for (const block of content) {
      if (block.type === 'text') {
        if (block.text.length > 0)
          items.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        items.push({
          type: 'image',
          data: block.data,
          mimeType: block.mimeType,
        })
      } else {
        const rendered = renderTranscript([{ role: 'user', content: [block] }])
        if (rendered.length > 0) items.push({ type: 'text', text: rendered })
      }
    }
    if (items.length === 0) items.push({ type: 'text', text: '(no output)' })
    return { content: items, ...(isError ? { isError: true } : {}) }
  }

  /** Release residual work for the Pi run that owns this session. */
  settleSession(sessionId: string): void {
    const conv = this.conversations.get(sessionId)
    if (conv !== undefined) this.dropTurn(conv, 'The owning Pi run settled.')
  }

  private dropTurn(conv: Conversation, reason: string): void {
    const turn = conv.turn
    if (turn === undefined) return
    if (!turn.finished && conv.sessionId !== undefined)
      conv.process?.cancel(conv.sessionId)
    conv.turn = undefined
    turn.abandon(reason)
    conv.dirty = true
    conv.reportedToolCalls.clear()
  }

  /** A conversation is idle only when no turn is running and no session is opening. */
  private isIdle(conv: Conversation): boolean {
    return conv.turn === undefined && !conv.opening
  }

  private async afterStep(conv: Conversation): Promise<void> {
    conv.lastUsed = this.monotonicNow()
    conv.idleMs = 0
    this.processIdleMs = 0
    const idle = this.isIdle(conv)
    if (idle && conv.key.startsWith('anon-')) {
      await this.resetSession(conv)
      this.conversations.delete(conv.key)
      return
    }
    // A failed opening leaves an unusable empty shell: release its capacity slot.
    if (
      idle &&
      conv.sessionId === undefined &&
      this.conversations.get(conv.key) === conv
    ) {
      this.conversations.delete(conv.key)
    }
  }

  private listTools(tenantKey: string | undefined): BridgeTool[] {
    const conv =
      tenantKey === undefined ? undefined : this.tenants.get(tenantKey)
    if (conv === undefined) return []
    return [...conv.advertisedTools, CALL_TOOL]
  }

  private async callTool(
    request: BridgeCallRequest,
  ): Promise<BridgeToolResult> {
    // Only the tenant mounted for this exact conversation may drive its tools;
    // a bare `conversationId` never grants routing on its own.
    const conv =
      request.tenantKey !== undefined
        ? this.tenants.get(request.tenantKey)
        : undefined
    if (conv === undefined)
      return toolError('No harness turn is waiting for this tool call.')
    if (
      request.conversationId !== undefined &&
      (conv.sessionId === undefined ||
        request.conversationId !== conv.sessionId)
    )
      return toolError('Tenant session mismatch.')
    const turn = conv.turn
    if (turn === undefined || turn.finished)
      return toolError('No harness turn is waiting for this tool call.')
    const detachAfterMs =
      this.host.detachAfterMs ??
      this.host.config.detachAfterMs ??
      defaults.detachAfterMs
    const cancelTimeoutMs =
      this.host.cancelTimeoutMs ??
      this.host.config.cancelTimeoutMs ??
      defaults.cancelTimeoutMs

    let name = request.name
    let args: Record<string, unknown> = request.arguments
    if (name === CALL_TOOL_NAME) {
      if (
        typeof request.arguments.name !== 'string' ||
        request.arguments.name.trim().length === 0
      ) {
        return toolError(
          formatValidationError(CALL_TOOL_NAME, [
            '$.name: expected non-empty string',
          ]),
        )
      }
      const rawTarget = request.arguments.name.trim()
      name = rawTarget.startsWith(AGENT_TOOL_PREFIX)
        ? rawTarget.slice(AGENT_TOOL_PREFIX.length)
        : rawTarget
      const rawArgs = request.arguments.arguments
      if (rawArgs === undefined) {
        args = {}
      } else if (
        rawArgs !== null &&
        typeof rawArgs === 'object' &&
        !Array.isArray(rawArgs)
      ) {
        args = rawArgs as Record<string, unknown>
      } else {
        return toolError(
          formatValidationError(CALL_TOOL_NAME, [
            '$.arguments: expected object',
          ]),
        )
      }
    }
    const schema = conv.toolSchemas.get(name)
    if (schema === undefined || !conv.toolNames.has(name))
      return toolError(`The harness has no tool named ${name}.`)

    const validation = validateToolArguments(schema.inputSchema, args)
    if (!validation.valid) {
      return toolError(formatValidationError(name, validation.errors))
    }

    const sessionId = conv.sessionId
    const proc = conv.process
    return turn.invokeTool(
      name,
      args,
      detachAfterMs,
      () => {
        if (
          conv.turn === turn &&
          sessionId !== undefined &&
          proc !== undefined
        ) {
          void turn.startDetach(() => proc.cancel(sessionId), cancelTimeoutMs)
        }
      },
      request.signal,
      request.commit,
    )
  }

  private stopSweeper(): void {
    if (this.sweeper !== undefined) {
      clearInterval(this.sweeper)
      this.sweeper = undefined
    }
  }

  private hasLiveConversations(): boolean {
    for (const conv of this.conversations.values()) {
      if (conv.sessionId !== undefined || !this.isIdle(conv)) return true
    }
    return false
  }

  private detachProcess(proc: AcpProcess): void {
    if (this.process !== proc) return
    this.stopSweeper()
    this.process = undefined
    this.processFingerprint = undefined
    this.processIdleMs = 0
    if (this.lifecycle === 'active') this.state = 'idle'
    proc.stop()
  }

  private async stopIdleProcess(
    proc: AcpProcess,
    options: { ignoreWarmup?: boolean } = {},
  ): Promise<void> {
    if (
      this.process !== proc ||
      this.lifecycle !== 'active' ||
      this.starting !== undefined ||
      this.activeStreams > 0 ||
      (!options.ignoreWarmup && this.warmupPromise !== undefined) ||
      this.hasLiveConversations()
    ) {
      return
    }
    this.detachProcess(proc)
    await this.bridge.close()
  }

  private sweep(): void {
    const ttl = this.host.config.idleSessionTtlMs
    const now = this.monotonicNow()
    const delta = Math.max(0, now - this.lastSweepAt)
    this.lastSweepAt = now
    const slice = Math.min(delta, SWEEP_INTERVAL_MS * 2)
    let allIdle =
      this.activeStreams === 0 &&
      this.warmupPromise === undefined &&
      this.starting === undefined
    const evictions: Promise<void>[] = []
    for (const conv of [...this.conversations.values()]) {
      if (!this.isIdle(conv)) {
        allIdle = false
        continue
      }
      conv.idleMs += slice
      if (conv.idleMs > ttl) {
        evictions.push(
          this.resetSession(conv).catch((error: unknown) => {
            this.host.log.warn(
              `session sweep cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
            )
          }),
        )
        this.conversations.delete(conv.key)
      }
    }
    if (!allIdle || this.process?.alive !== true) {
      this.processIdleMs = 0
      return
    }
    this.processIdleMs += slice
    if (this.processIdleMs > ttl && !this.hasLiveConversations()) {
      const proc = this.process
      if (evictions.length === 0) {
        void this.stopIdleProcess(proc)
      } else {
        void Promise.allSettled(evictions).then(() =>
          this.stopIdleProcess(proc),
        )
      }
    }
  }
}

function clampEffortToOptions(
  configOptions: readonly AcpConfigOption[],
  effort: Effort,
): Effort {
  const levelOption = configOptions.find(
    (o) => o.id === 'thought_level' || o.category === 'thought_level',
  )
  if (levelOption?.options === undefined) return effort
  const offered = flattenConfigOptions(levelOption.options)
    .map((o) => asEffort(o.value))
    .filter((v): v is Effort => v !== undefined)
  if (offered.length === 0 || offered.includes(effort)) return effort
  return nearestEffort(effort, offered)
}

function statSignature(path: string): string {
  try {
    const st = statSync(path, { bigint: true })
    return `${st.isDirectory() ? 'd' : 'f'}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}:${st.size}`
  } catch {
    return 'missing'
  }
}

function logPathsFingerprint(paths: readonly string[]): string {
  const parts: string[] = []
  for (const p of paths) {
    const sig = statSignature(p)
    parts.push(`${p}=${sig}`)
    if (sig.startsWith('d:')) {
      parts.push(`${p}/cli.log=${statSignature(join(p, 'cli.log'))}`)
      parts.push(`${p}/log=${statSignature(join(p, 'log'))}`)
    }
  }
  return parts.join('|')
}

function messageIds(messages: readonly RequestMessage[]): string[] {
  return messages.map((m) => m.id ?? '')
}

function toolError(text: string): BridgeToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/**
 * Map transport and agent failures onto stable Pi failure codes.
 * @param error - the failure.
 * @returns an LlmError.
 */
export function mapError(error: unknown): Error {
  if (error instanceof LlmError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof JsonRpcClosedError)
    return new LlmError(
      `Antigravity ACP link closed: ${message}`,
      'TRANSPORT',
      { cause: error },
    )
  if (
    /authentication required|not logged in|unauthenticated|sign in/i.test(
      message,
    )
  ) {
    return new LlmError(
      `Antigravity requires sign-in: run \`agy\` once in a terminal (${message})`,
      'AUTH',
      { cause: error },
    )
  }
  if (/timeout|timed out|deadline/i.test(message))
    return new LlmError(message, 'TIMEOUT', { cause: error })
  if (
    /context.*(length|window|limit|overflow|exceeded)|too long|token limit|maximum.*tokens/i.test(
      message,
    )
  )
    return new LlmError(message, 'CONTEXT_WINDOW_EXCEEDED', { cause: error })
  if (/rate.?limit|429|too many requests|overloaded|capacity/i.test(message))
    return new LlmError(message, 'RATE_LIMIT', { cause: error })
  if (/quota|resource.?exhausted|limit reached|exceeded your/i.test(message))
    return new LlmError(message, 'QUOTA', { cause: error })
  if (error instanceof JsonRpcRemoteError)
    return new LlmError(`Antigravity: ${message}`, 'SERVER', { cause: error })
  return new LlmError(message, 'TRANSPORT', { cause: error })
}
