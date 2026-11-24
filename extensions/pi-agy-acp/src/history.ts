/**
 * Projection of Pi request history into Antigravity ACP prompts.
 *
 * ACP sessions own their history, so `session/new` appends only the static MCP
 * tool-routing preamble while `<system_instructions>`,
 * `<harness_tool_instructions>`, and `<pi_history>` travel in a session's
 * opening prompt; subsequent turns send only new input. The replay renders
 * earlier turns as a delimited transcript in front of the newest user input;
 * tool calls keep the agent-visible `mcp_pi_` names.
 * @module pi-agy-acp/history
 */

import type {
  ContentBlock,
  GenerateOptions,
  RequestMessage,
} from './protocol.ts'

/** Server name under which Pi tools reach the agent; the agent prefixes tool names with `mcp_<server>_`. */
export const MCP_SERVER_NAME = 'pi'
/** Agent-visible prefix of every Pi tool. */
export const AGENT_TOOL_PREFIX = `mcp_${MCP_SERVER_NAME}_`
/** Fallback MCP tool name for invoking any Pi tool omitted from direct declarations. */
export const CALL_TOOL_NAME = 'pi_call_tool'

/**
 * Replay budget for `agy`, kept below its `64,000 * 3 = 192,000`
 * byte single-`USER_INPUT` truncation limit so the agent never tail-truncates
 * a replay prompt.
 */
export const REPLAY_BUDGET_BYTES = 160_000

const HISTORY_OPEN = '<pi_history>\n'
const HISTORY_CLOSE = '\n</pi_history>\n\n'
/** Upper bound of the omission notice, reserved before history is selected. */
const OMISSION_NOTICE_RESERVE_BYTES = 128

/**
 * Live input for a rebuild whose trailing messages are all tool results (for
 * example right after compaction in the middle of a tool loop), so the agent
 * receives a meaningful instruction instead of an empty prompt.
 */
export const EMPTY_INPUT_CONTINUATION =
  'Continue the task from the latest tool results above.'

/** One ACP prompt content block. */
export type AcpPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/** System prompt and conversation messages split from one request. */
export interface SplitRequest {
  system: string
  messages: readonly RequestMessage[]
}

/**
 * Split leading system messages (and the one-shot `system` field) from history.
 * @param options - the model request.
 * @returns the combined system text and the remaining messages.
 */
export function splitSystem(options: GenerateOptions): SplitRequest {
  const parts: string[] = []
  if (options.system !== undefined && options.system.length > 0)
    parts.push(options.system)
  let index = 0
  for (const message of options.messages) {
    if (message.role !== 'system') break
    parts.push(textOf(message.content))
    index++
  }
  return {
    system: parts.filter(Boolean).join('\n\n'),
    messages: options.messages.slice(index),
  }
}

/**
 * Join the text blocks of one message.
 * @param content - message content blocks.
 * @returns concatenated text.
 */
export function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter(
      (b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text',
    )
    .map((b) => b.text)
    .join('')
}

/** Compacted initial tool declaration forwarded in the session preamble. */
export interface SupplementalTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Default cap on historical images preserved during fallback replay. */
export const DEFAULT_MAX_HISTORICAL_IMAGES = 4
/** Default total base64 byte cap for preserved historical images during fallback replay. */
export const DEFAULT_MAX_HISTORICAL_IMAGE_BYTES = 4 * 1024 * 1024

/** Options controlling session preamble rendering and replay budgeting. */
export interface ReplayPromptOptions {
  system?: string
  supplementalTools?: readonly SupplementalTool[]
  maxHistoryBytes?: number
  maxPreambleBytes?: number
  /** Whether to attach recent historical images as native image blocks (defaults to true). */
  preserveImages?: boolean
  /** Maximum number of recent historical images preserved on fallback replay (defaults to 4). */
  maxHistoricalImages?: number
  /** Maximum total base64 bytes across preserved historical images (defaults to 4 MiB). */
  maxHistoricalImageBytes?: number
}

/**
 * Static bridge instructions appended to the agent's system prompt.
 * @returns the static bridge preamble.
 */
export function bridgeSystemPrompt(): string {
  return [
    'You are the primary model of a Pi coding agent session. The harness owns the conversation, the tools, and their permissions.',
    `Every harness tool is available to you under the prefix \`${AGENT_TOOL_PREFIX}\`: a tool named \`X\` in the harness instructions is the tool \`${AGENT_TOOL_PREFIX}X\`. If \`${AGENT_TOOL_PREFIX}X\` is absent from your direct tool declarations, invoke it via \`${AGENT_TOOL_PREFIX}${CALL_TOOL_NAME}\` with \`{"name":"X","arguments":{...}}\`. Use only these tools; pass arguments exactly as their schemas define.`,
    'When the first user message contains <system_instructions>, <harness_tool_instructions>, or <pi_history> blocks, treat <system_instructions> and <harness_tool_instructions> as harness instructions for the entire session and <pi_history> as the earlier part of this conversation; continue from the newest input after them without repeating completed actions.',
  ].join('\n')
}

/**
 * Render the harness system prompt and compacted initial tool instructions for
 * delivery at the head of a session's opening prompt.
 * @param system - the Pi system prompt.
 * @param supplementalTools - initially advertised tools whose MCP schemas were compacted, preserving their full instructions.
 * @returns the delimited instruction preamble ending in a blank line, or empty string when absent.
 */
export function renderSessionInstructions(
  system: string,
  supplementalTools: readonly SupplementalTool[] = [],
  budget: number = Infinity,
): string {
  const sections: string[] = []
  if (system.length > 0) {
    sections.push(`<system_instructions>\n${system}\n</system_instructions>`)
  }
  if (supplementalTools.length > 0) {
    let entries: string[] = []
    let totalBytes = 0
    for (const t of supplementalTools) {
      const entry = JSON.stringify({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })
      if (totalBytes + entry.length + 1 > budget) break
      entries.push(entry)
      totalBytes += entry.length + 1
    }
    if (entries.length < supplementalTools.length) {
      entries.push(
        JSON.stringify({
          name: 'tool_search',
          description:
            'Search for tools that are not loaded yet and load the matches',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              limit: { type: 'number' },
            },
          },
        }),
      )
    }
    sections.push(
      `<harness_tool_instructions>\n${entries.join('\n')}\n</harness_tool_instructions>`,
    )
  }
  return sections.length > 0 ? `${sections.join('\n\n')}\n\n` : ''
}

/**
 * Render a list of messages as transcript text.
 * @param messages - earlier conversation messages.
 * @returns transcript lines.
 */
export function renderTranscript(messages: readonly RequestMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'user':
        lines.push(`<user>\n${renderBlocks(message.content)}\n</user>`)
        break
      case 'assistant': {
        const text = renderBlocks(
          message.content.filter(
            (b) => b.type !== 'tool-call' && b.type !== 'reasoning',
          ),
        )
        if (text.length > 0) lines.push(`<assistant>\n${text}\n</assistant>`)
        for (const block of message.content) {
          if (block.type === 'tool-call') {
            lines.push(
              `<tool_call id="${block.id}" name="${AGENT_TOOL_PREFIX}${block.name}">\n${block.arguments}\n</tool_call>`,
            )
          }
        }
        break
      }
      case 'tool':
        lines.push(
          `<tool_result id="${message.toolCallId}"${message.isError === true ? ' error="true"' : ''}>\n${renderBlocks(message.content)}\n</tool_result>`,
        )
        break
      case 'system':
        lines.push(
          `<system_update>\n${renderBlocks(message.content)}\n</system_update>`,
        )
        break
      default:
        break
    }
  }
  return lines.join('\n\n')
}

function renderBlocks(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'image':
        parts.push('[image]')
        break
      default:
        break
    }
  }
  return parts.join('\n')
}

/**
 * Convert one user-role message into ACP prompt blocks.
 * @param content - user content blocks.
 * @returns prompt blocks in content order.
 */
export function promptBlocks(
  content: readonly ContentBlock[],
): AcpPromptBlock[] {
  const blocks: AcpPromptBlock[] = []
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text.length > 0) blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      blocks.push({ type: 'image', data: block.data, mimeType: block.mimeType })
    } else {
      const text = renderBlocks([block])
      if (text.length > 0) blocks.push({ type: 'text', text })
    }
  }
  return blocks
}

/**
 * Build the prompt that (re)creates a session: harness system/tool instructions,
 * earlier history as transcript, and trailing input messages as live content.
 *
 * The trailing input and session instructions are always complete. History
 * renders newest-first into the remaining byte budget, so the most recent turns
 * survive and only the oldest messages are omitted; an omitted prefix is
 * announced inside the block. The `<pi_history>` block is always closed before
 * the live input. When the plan leaves no trailing input (the history ends with
 * tool results), a short continuation instruction is appended so the prompt is
 * never empty.
 * @param history - messages before the trailing input.
 * @param input - trailing input messages sent as live content.
 * @param options - session instructions and replay byte ceiling; defaults to {@link REPLAY_BUDGET_BYTES}.
 * @returns prompt blocks.
 */
export function replayPrompt(
  history: readonly RequestMessage[],
  input: readonly RequestMessage[],
  options: ReplayPromptOptions = {},
): AcpPromptBlock[] {
  const preamble = renderSessionInstructions(
    options.system ?? '',
    options.supplementalTools ?? [],
    options.maxPreambleBytes ?? 50000,
  )
  const inputBlocks: AcpPromptBlock[] =
    input.length > 0
      ? inputPrompt(input)
      : [{ type: 'text', text: EMPTY_INPUT_CONTINUATION }]
  const blocks: AcpPromptBlock[] = []
  if (preamble.length > 0) blocks.push({ type: 'text', text: preamble })
  if (history.length > 0) {
    const maxBytes = options.maxHistoryBytes ?? REPLAY_BUDGET_BYTES
    const preambleBytes = utf8Bytes(preamble)
    const inputBytes = inputBlocks.reduce(
      (total, block) =>
        total + (block.type === 'text' ? utf8Bytes(block.text) : 0),
      0,
    )
    const overhead =
      utf8Bytes(HISTORY_OPEN) +
      utf8Bytes(HISTORY_CLOSE) +
      OMISSION_NOTICE_RESERVE_BYTES
    const historyBlocks = historyTranscriptBlocks(
      history,
      Math.max(0, maxBytes - preambleBytes - inputBytes - overhead),
      {
        preserveImages: options.preserveImages ?? true,
        maxImages: options.maxHistoricalImages ?? DEFAULT_MAX_HISTORICAL_IMAGES,
        maxImageBytes:
          options.maxHistoricalImageBytes ?? DEFAULT_MAX_HISTORICAL_IMAGE_BYTES,
      },
    )
    blocks.push(...historyBlocks)
  }
  blocks.push(...inputBlocks)
  return blocks
}

interface HistoricalImageSelection {
  preserveImages: boolean
  maxImages: number
  maxImageBytes: number
}

interface KeptHistoryEntry {
  message: RequestMessage
  rendered: string
  truncated: boolean
}

/**
 * Render the newest messages that fit `budget`, announcing any omitted prefix,
 * and preserving the most recent historical images as native image blocks when
 * supported and within image limits.
 */
function historyTranscriptBlocks(
  history: readonly RequestMessage[],
  budget: number,
  imageOptions: HistoricalImageSelection,
): AcpPromptBlock[] {
  const entries: KeptHistoryEntry[] = []
  let used = 0
  let dropped = 0
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index] as RequestMessage
    const rendered = renderTranscript([message])
    const separator = entries.length === 0 ? 0 : 2
    const bytes = utf8Bytes(rendered)
    if (used + separator + bytes > budget) {
      if (entries.length === 0 && message.role === 'tool' && budget > 1024) {
        const truncated = truncatedToolTranscript(message, budget)
        if (truncated !== undefined) {
          entries.unshift({ message, rendered: truncated, truncated: true })
          dropped = index
        } else {
          dropped = index + 1
        }
      } else {
        dropped = index + 1
      }
      break
    }
    entries.unshift({ message, rendered, truncated: false })
    used += separator + bytes
  }
  if (entries.length === 0 && dropped === 0) return []

  // Select up to `maxImages` newest historical images from user/tool messages within the image byte budget.
  const selectedImages = new Map<
    number,
    { blockIndex: number; ordinal: number; data: string; mimeType: string }[]
  >()
  if (
    imageOptions.preserveImages &&
    imageOptions.maxImages > 0 &&
    imageOptions.maxImageBytes > 0
  ) {
    const picked: {
      entryIndex: number
      blockIndex: number
      data: string
      mimeType: string
    }[] = []
    let imageBytes = 0
    for (
      let entryIndex = entries.length - 1;
      entryIndex >= 0 && picked.length < imageOptions.maxImages;
      entryIndex--
    ) {
      const entry = entries[entryIndex] as KeptHistoryEntry
      if (
        entry.truncated ||
        (entry.message.role !== 'user' && entry.message.role !== 'tool')
      ) {
        continue
      }
      for (
        let blockIndex = entry.message.content.length - 1;
        blockIndex >= 0 && picked.length < imageOptions.maxImages;
        blockIndex--
      ) {
        const block = entry.message.content[blockIndex]
        if (block?.type !== 'image' || block.data.length === 0) continue
        const size = utf8Bytes(block.data)
        if (imageBytes + size > imageOptions.maxImageBytes) continue
        imageBytes += size
        picked.push({
          entryIndex,
          blockIndex,
          data: block.data,
          mimeType: block.mimeType,
        })
      }
    }
    // Restore chronological order and assign 1-based ordinals.
    picked.reverse()
    picked.forEach((item, idx) => {
      const list = selectedImages.get(item.entryIndex) ?? []
      list.push({
        blockIndex: item.blockIndex,
        ordinal: idx + 1,
        data: item.data,
        mimeType: item.mimeType,
      })
      selectedImages.set(item.entryIndex, list)
    })
  }

  const parts: string[] = []
  if (dropped > 0) {
    parts.push(
      `[Earlier ${dropped} history messages omitted to fit the context replay budget]`,
    )
  }
  const trailingImages: Extract<AcpPromptBlock, { type: 'image' }>[] = []
  entries.forEach((entry, entryIndex) => {
    const imgs = selectedImages.get(entryIndex)
    if (imgs === undefined || imgs.length === 0) {
      parts.push(entry.rendered)
      return
    }
    const byBlock = new Map(imgs.map((i) => [i.blockIndex, i.ordinal]))
    const renderedWithRefs = renderMessageWithImageRefs(entry.message, byBlock)
    parts.push(renderedWithRefs)
    for (const img of imgs) {
      trailingImages.push({
        type: 'image',
        data: img.data,
        mimeType: img.mimeType,
      })
    }
  })

  if (parts.length === 0) return []
  const transcriptText = `${HISTORY_OPEN}${parts.join('\n\n')}${HISTORY_CLOSE}`
  if (trailingImages.length === 0) {
    return [{ type: 'text', text: transcriptText }]
  }
  return [
    { type: 'text', text: transcriptText },
    ...trailingImages,
  ]
}

function renderMessageWithImageRefs(
  message: RequestMessage,
  ordinalsByBlock: ReadonlyMap<number, number>,
): string {
  const body = message.content
    .flatMap((block, idx) => {
      if (block.type === 'text') return [block.text]
      if (block.type === 'image') {
        const ordinal = ordinalsByBlock.get(idx)
        return [ordinal !== undefined ? `[historical image #${ordinal} attached below]` : '[image]']
      }
      return []
    })
    .join('\n')
  if (message.role === 'user') return `<user>\n${body}\n</user>`
  if (message.role === 'tool') {
    return `<tool_result id="${message.toolCallId}"${message.isError === true ? ' error="true"' : ''}>\n${body}\n</tool_result>`
  }
  return renderTranscript([message])
}

/**
 * Render detached or post-turn tool results as ACP prompt blocks, preserving
 * any native image blocks returned by the tools.
 */
export function toolResultsPrompt(
  results: readonly Extract<RequestMessage, { role: 'tool' }>[],
  options: {
    suffix?: string
    extras?: readonly RequestMessage[]
    preserveImages?: boolean
  } = {},
): AcpPromptBlock[] {
  const preserveImages = options.preserveImages ?? true
  const blocks: AcpPromptBlock[] = []
  const images: Extract<AcpPromptBlock, { type: 'image' }>[] = []
  let ordinal = 0
  const transcriptParts: string[] = []
  for (const result of results) {
    const ordinals = new Map<number, number>()
    if (preserveImages) {
      result.content.forEach((block, idx) => {
        if (block.type === 'image' && block.data.length > 0) {
          ordinal++
          ordinals.set(idx, ordinal)
          images.push({
            type: 'image',
            data: block.data,
            mimeType: block.mimeType,
          })
        }
      })
    }
    transcriptParts.push(
      ordinals.size > 0
        ? renderMessageWithImageRefs(result, ordinals)
        : renderTranscript([result]),
    )
  }
  const sections: string[] = [transcriptParts.join('\n\n')]
  if (options.suffix && options.suffix.length > 0) sections.push(options.suffix)
  sections.push('Continue the task with these tool results.')
  blocks.push({ type: 'text', text: sections.join('\n\n') })
  blocks.push(...images)
  if (options.extras && options.extras.length > 0) {
    blocks.push(...inputPrompt(options.extras))
  }
  return blocks
}

/**
 * Render one oversized tool result with its head kept inside `budget`.
 * @param message - the newest tool message.
 * @param budget - byte budget for its rendered transcript.
 * @returns the truncated transcript, or undefined when even the markup does not fit.
 */
function truncatedToolTranscript(
  message: Extract<RequestMessage, { role: 'tool' }>,
  budget: number,
): string | undefined {
  const marker = '\n[tool result truncated to fit the context replay budget]'
  let limit = budget - utf8Bytes(marker)
  for (let attempt = 0; attempt < 8 && limit > 0; attempt++) {
    const content: ContentBlock[] = [
      {
        type: 'text',
        text: `${headWithinBytes(renderBlocks(message.content), limit)}${marker}`,
      },
    ]
    const rendered = renderTranscript([{ ...message, content }])
    const bytes = utf8Bytes(rendered)
    if (bytes <= budget) return rendered
    limit -= bytes - budget
  }
  return undefined
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function headWithinBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let end = Math.max(0, maxBytes)
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end--
  return bytes.subarray(0, end).toString('utf8')
}

/**
 * Convert new input messages (user and system notices) into live prompt blocks.
 * @param input - messages that arrived after the session's known history.
 * @returns prompt blocks.
 */
export function inputPrompt(
  input: readonly RequestMessage[],
): AcpPromptBlock[] {
  const blocks: AcpPromptBlock[] = []
  for (const message of input) {
    if (message.role === 'user') blocks.push(...promptBlocks(message.content))
    else {
      const text = renderTranscript([message])
      if (text.length > 0) blocks.push({ type: 'text', text })
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: 'Continue.' })
  return blocks
}
