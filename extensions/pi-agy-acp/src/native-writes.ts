import { lstatSync, realpathSync } from 'node:fs'
import {
  basename, dirname, isAbsolute, join, relative, resolve, sep,
} from 'node:path'
import type { AcpPermissionRequest } from './acp-process.ts'

/** Names accepted in agy's custom-agent `tools` list. */
export const NATIVE_AGENT_WRITERS = [
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
] as const

/** agy reports newer aliases over ACP even with the documented names enabled. */
export function hostWriter(name: string | undefined): 'edit' | 'write' | undefined {
  switch (name) {
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'edit_file':
      return 'edit'
    case 'write_to_file':
    case 'write_file':
    case 'create_file':
      return 'write'
  }
}

function canonicalTarget(raw: string, root: string): string | undefined {
  // Resolve relative tool paths against the actual ACP workspace. Reject traversal
  // before lexical normalization (especially `symlink/..`).
  if (
    raw.trim().length === 0 || raw.includes('\0') ||
    raw.split(/[\\/]/).includes('..')
  ) return
  let current = resolve(root, raw)
  const missing: string[] = []
  try {
    for (;;) {
      let stat
      try {
        stat = lstatSync(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
        const parent = dirname(current)
        if (parent === current) return
        missing.unshift(basename(current))
        current = parent
        continue
      }
      // Resolve even a symlink found while climbing; a dangling symlink fails
      // here, rather than being mistaken for a file that can safely be created.
      const existing = realpathSync(current)
      if (stat.isSymbolicLink()) stat = lstatSync(existing)
      if (missing.length > 0) {
        if (!stat.isDirectory()) return
      } else if (!stat.isFile() || stat.nlink !== 1) return
      const target = join(existing, ...missing)
      const rel = relative(root, target)
      if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return
      return target
    }
  } catch {
    return
  }
}

/** Require one consistent file target, including any reported ACP locations. */
export function nativeWriteTarget(
  root: string,
  call: AcpPermissionRequest['toolCall'],
): string | undefined {
  const input = call?.rawInput
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return
  const args = input as Record<string, unknown>
  const rawTargets = [args.Path, args.TargetFile].filter((value) => value !== undefined)
  if (rawTargets.length === 0) return
  if (call?.locations !== undefined) {
    if (!Array.isArray(call.locations)) return
    for (const location of call.locations) rawTargets.push(location?.path)
  }
  let target: string | undefined
  for (const raw of rawTargets) {
    if (typeof raw !== 'string') return
    const path = canonicalTarget(raw, root)
    if (path === undefined || (target !== undefined && path !== target)) return
    target = path
  }
  return target
}
