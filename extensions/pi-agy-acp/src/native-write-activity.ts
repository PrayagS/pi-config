import type { AcpSessionUpdate } from './acp-process.ts'
import type { ReportedToolCall } from './conversation.ts'
import { hostWriter, nativeWriteTarget } from './native-writes.ts'

const MAX_DIFF_CHARS = 48_000
const MAX_DIFF_LINES = 450
const MAX_PENDING_PREVIEWS = 32

interface NativeWriteDiff {
  oldText: string
  newText: string
}

type DiffPreview = { diff: NativeWriteDiff } | { diffOmitted: true }

export type NativeWriteActivityRecord = {
  toolCallId: string
  name: string
  status: 'completed' | 'failed'
  path?: string
  diff?: NativeWriteDiff
  diffOmitted?: boolean
}

/** Only present file-copy pairs from agy's native diff, never read files for display. */
function diffFromUpdate(update: AcpSessionUpdate, root: string, path: string): DiffPreview | undefined {
  if (!Array.isArray(update.content)) return
  for (const block of update.content) {
    if (
      block?.type !== 'diff' || typeof block.path !== 'string' ||
      typeof block.newText !== 'string' ||
      (block.oldText !== undefined && typeof block.oldText !== 'string') ||
      nativeWriteTarget(root, { rawInput: { Path: block.path } }) !== path
    ) continue
    const oldText = block.oldText ?? ''
    const newText = block.newText
    if (
      oldText.length + newText.length > MAX_DIFF_CHARS ||
      oldText.split('\n', MAX_DIFF_LINES + 1).length +
        newText.split('\n', MAX_DIFF_LINES + 1).length > MAX_DIFF_LINES
    ) return { diffOmitted: true }
    return { diff: { oldText, newText } }
  }
}

function displayPath(update: AcpSessionUpdate): string | undefined {
  const input = update.rawInput as { Path?: unknown; TargetFile?: unknown } | undefined
  const path = update.locations?.[0]?.path ?? input?.Path ?? input?.TargetFile
  return typeof path === 'string' ? path.slice(0, 1024) : undefined
}

/** Merge ACP progress frames and emit at most one display entry per native tool call. */
export class NativeWriteActivity {
  private readonly pending = new Map<string, { path?: string; preview?: DiffPreview }>()
  private readonly displayed = new Set<string>()

  observe(
    update: AcpSessionUpdate,
    reported: ReportedToolCall,
    root: string,
  ): NativeWriteActivityRecord | undefined {
    const id = update.toolCallId
    const name = reported.toolName
    if (
      (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') ||
      id === undefined || this.displayed.has(id) || reported.conflict ||
      name === undefined || hostWriter(name) === undefined ||
      reported.serverName !== `non-pi:${name}` || reported.kind !== 'edit'
    ) return

    const status = update.status
    const path = reported.nativeWritePath
    const previous = this.pending.get(id)
    const label = path ?? displayPath(update) ?? previous?.path
    const preview = status !== 'failed' && path !== undefined
      ? diffFromUpdate(update, root, path) ?? previous?.preview
      : undefined
    if (status !== 'completed' && status !== 'failed') {
      if (previous !== undefined || this.pending.size < MAX_PENDING_PREVIEWS)
        this.pending.set(id, { path: label, preview })
      return
    }

    this.pending.delete(id)
    this.displayed.add(id)
    return { toolCallId: id, name, status, path: label, ...preview }
  }
}
