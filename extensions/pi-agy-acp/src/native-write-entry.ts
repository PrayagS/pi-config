import { basename } from 'node:path'
import { generateUnifiedPatch, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import type { NativeWriteActivityRecord } from './native-write-activity.ts'

const ENTRY_TYPE = 'agy-native-write'
const MAX_PATCH_CHARS = 12_000

type NativeWriteEntry = Omit<NativeWriteActivityRecord, 'diff'> & { diff?: string }

// ACP file names and diffs are untrusted terminal text. Keep tabs and line breaks
// for the patch but never let its bytes supply their own terminal controls.
function plainText(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '\ufffd')
}

function plainPath(path: string): string {
  return plainText(path).replace(/[\t\n]/g, '\ufffd')
}

export function appendNativeWriteEntry(pi: ExtensionAPI, activity: NativeWriteActivityRecord): void {
  const { diff: nativeDiff, ...detail } = activity
  let diff: string | undefined
  if (nativeDiff !== undefined && nativeDiff.oldText !== nativeDiff.newText) {
    try {
      const patch = plainText(generateUnifiedPatch(
        plainPath(activity.path ?? 'file'), nativeDiff.oldText, nativeDiff.newText,
      ))
      diff = patch.length <= MAX_PATCH_CHARS
        ? patch
        : `${patch.slice(0, MAX_PATCH_CHARS)}\n[diff truncated]`
    } catch {
      detail.diffOmitted = true
    }
  }
  pi.appendEntry<NativeWriteEntry>(ENTRY_TYPE, { ...detail, diff })
}

export function registerNativeWriteEntries(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<NativeWriteEntry>(ENTRY_TYPE, (entry, { expanded }, theme) => {
    const data = entry.data
    if (data === undefined) return new Text('agy file tool', 0, 0)
    const mark = data.status === 'completed' ? theme.fg('success', '✓') : theme.fg('error', '✗')
    const path = data.path === undefined ? undefined : plainPath(data.path)
    const title = theme.fg('toolTitle', `agy ${plainPath(data.name)}`)
    const lines = [`${mark} ${title}${path ? ` ${theme.fg('muted', basename(path))}` : ''}`]
    if (expanded) {
      if (path) lines.push(theme.fg('dim', path))
      if (data.diff) {
        for (const line of plainText(data.diff).trimEnd().split('\n')) {
          const color = line.startsWith('+') ? 'toolDiffAdded' : line.startsWith('-') ? 'toolDiffRemoved' : 'toolDiffContext'
          lines.push(theme.fg(color, line))
        }
      } else if (data.diffOmitted) {
        lines.push(theme.fg('muted', 'Diff preview unavailable.'))
      } else if (data.status === 'failed') {
        lines.push(theme.fg('muted', 'agy reported that the file operation failed.'))
      }
    }
    return new Text(lines.join('\n'), 0, 0)
  })
}
