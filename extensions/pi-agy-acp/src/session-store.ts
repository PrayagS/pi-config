/**
 * WAL-safe SQLite conversation checkpoints, copy-on-rewind forks (`VACUUM INTO`),
 * and persistent Pi-to-ACP session index for `session/resume` / `session/load`.
 * @module pi-agy-acp/session-store
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Effort } from './config.ts'
import { textOf } from './history.ts'
import type { RequestMessage } from './protocol.ts'
import {
  removeSessionArtifacts,
  resolveSessionDbPath,
} from './session-db.ts'
import { digest } from './util.ts'

const INDEX_FILE = 'session-index.json'
const MAX_CHECKPOINTS = 96
const MAX_PERSISTED_SESSIONS = 32

/** Append-order SQLite high-water marks (`coalesce(max(idx) + 1, 0)`). */
export interface ConversationHighWaterMarks {
  steps: number
  generations: number
  executions: number
}

/** One persisted turn-end checkpoint linking Pi history to an ACP SQLite DB. */
export interface PersistedCheckpoint {
  agySessionId: string
  piSessionKey: string
  systemHash: string
  /** Message IDs sent to ACP before the final assistant response of this turn. */
  knownIds: string[]
  /** Exact message IDs including the final assistant response once observed on a later turn. */
  completedIds?: string[]
  /** Short SHA-256 digest of the final assistant message's text content. */
  finalTextHash: string
  /** Tool call IDs issued in this session up to this checkpoint. */
  issuedIds: string[]
  /** Initial advertised tool digests when the ACP session opened. */
  advertisedToolDigests: Record<string, string>
  /** Known tool digests at this checkpoint. */
  knownTools: Record<string, string>
  /** SQLite high-water marks after this turn committed. */
  marks: ConversationHighWaterMarks
  /** SHA-256 fingerprint of all conversation rows strictly below `marks`. */
  dbFingerprint: string
  model?: string
  effort?: Effort
  updatedAt: number
}

/** Result of matching a Pi request against persisted checkpoints. */
export interface CheckpointMatch {
  checkpoint: PersistedCheckpoint
  /** New trailing user/system messages to send after resuming/forking. */
  input: readonly RequestMessage[]
  /** Message IDs up to and including the matched assistant turn (useful to pin `completedIds`). */
  completedIds: string[]
}

function presentTables(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name?: unknown }[]
  const names = new Set<string>()
  for (const row of rows) {
    if (typeof row.name === 'string') names.add(row.name)
  }
  return names
}

function nextIndex(
  db: DatabaseSync,
  tables: ReadonlySet<string>,
  table: 'steps' | 'gen_metadata' | 'executor_metadata',
): number {
  if (!tables.has(table)) return 0
  const row = db
    .prepare(`SELECT coalesce(max(idx) + 1, 0) AS next FROM ${table}`)
    .get() as { next?: unknown } | undefined
  return typeof row?.next === 'number' && Number.isSafeInteger(row.next)
    ? row.next
    : 0
}

function assertIdentity(
  db: DatabaseSync,
  tables: ReadonlySet<string>,
  sessionId: string,
): boolean {
  if (!tables.has('trajectory_meta')) return false
  const rows = db
    .prepare('SELECT cascade_id FROM trajectory_meta')
    .all() as { cascade_id?: unknown }[]
  return rows.length === 1 && rows[0]?.cascade_id === sessionId
}

function highWaterMarks(
  db: DatabaseSync,
  tables: ReadonlySet<string>,
): ConversationHighWaterMarks {
  return {
    steps: nextIndex(db, tables, 'steps'),
    generations: nextIndex(db, tables, 'gen_metadata'),
    executions: nextIndex(db, tables, 'executor_metadata'),
  }
}

function isValidMarks(marks: ConversationHighWaterMarks): boolean {
  return (
    Number.isSafeInteger(marks.steps) &&
    marks.steps > 0 &&
    Number.isSafeInteger(marks.generations) &&
    marks.generations >= 0 &&
    Number.isSafeInteger(marks.executions) &&
    marks.executions >= 0
  )
}

/** Compute a deterministic SHA-256 fingerprint of all rows below `marks`. */
export function prefixFingerprint(
  db: DatabaseSync,
  tables: ReadonlySet<string>,
  marks: ConversationHighWaterMarks,
): string {
  const hash = createHash('sha256')
  const targets = [
    ['steps', marks.steps],
    ['parent_references', marks.steps],
    ['gen_metadata', marks.generations],
    ['executor_metadata', marks.executions],
  ] as const
  for (const [table, end] of targets) {
    hash.update(table)
    hash.update('\0')
    if (!tables.has(table) || end <= 0) continue
    const stmt = db.prepare(`SELECT * FROM ${table} WHERE idx < ? ORDER BY idx`)
    for (const row of stmt.iterate(end) as Iterable<Record<string, unknown>>) {
      for (const key of Object.keys(row).sort()) {
        hash.update(JSON.stringify(key))
        const value = row[key]
        if (value instanceof Uint8Array) {
          hash.update(`blob:${value.byteLength}:`)
          hash.update(value)
        } else {
          const text = value === null ? 'null' : String(value)
          hash.update(`${typeof value}:${text.length}:${text}`)
        }
      }
      hash.update('\n')
    }
  }
  return hash.digest('hex')
}

/**
 * Snapshot a live session DB's current high-water marks and prefix fingerprint.
 * Strictly read-only and fail-closed (`undefined` on any error or empty DB).
 */
export function readConversationCheckpoint(
  home: string,
  agySessionId: string,
): { marks: ConversationHighWaterMarks; dbFingerprint: string } | undefined {
  const resolved = resolveSessionDbPath(home, agySessionId)
  if (resolved.kind !== 'ok') return undefined
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(resolved.dbPath, { readOnly: true, timeout: 50 })
    const tables = presentTables(db)
    if (!assertIdentity(db, tables, agySessionId)) return undefined
    const marks = highWaterMarks(db, tables)
    if (!isValidMarks(marks)) return undefined
    const dbFingerprint = prefixFingerprint(db, tables, marks)
    return { marks, dbFingerprint }
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

/**
 * Inspect whether `agySessionId`'s SQLite DB is still at `marks` (`exact`),
 * has advanced past `marks` with an intact prefix (`ahead` — needs copy-on-rewind fork),
 * or cannot safely be resumed/forked (`mismatch`).
 */
export function inspectConversationState(
  home: string,
  agySessionId: string,
  marks: ConversationHighWaterMarks,
  expectedFingerprint: string,
): 'exact' | 'ahead' | 'mismatch' {
  if (!isValidMarks(marks)) return 'mismatch'
  const resolved = resolveSessionDbPath(home, agySessionId)
  if (resolved.kind !== 'ok') return 'mismatch'
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(resolved.dbPath, { readOnly: true, timeout: 50 })
    const tables = presentTables(db)
    if (!assertIdentity(db, tables, agySessionId)) return 'mismatch'
    const current = highWaterMarks(db, tables)
    if (
      marks.steps > current.steps ||
      marks.generations > current.generations ||
      marks.executions > current.executions
    ) {
      return 'mismatch'
    }
    if (prefixFingerprint(db, tables, marks) !== expectedFingerprint) {
      return 'mismatch'
    }
    if (
      current.steps === marks.steps &&
      current.generations === marks.generations &&
      current.executions === marks.executions
    ) {
      return 'exact'
    }
    return 'ahead'
  } catch {
    return 'mismatch'
  } finally {
    db?.close()
  }
}

/**
 * Copy-on-rewind fork of an ACP conversation SQLite DB via WAL-safe `VACUUM INTO`.
 * Source DB and its WAL remain untouched; the new fork DB is truncated to `marks`
 * and assigned a fresh `cascade_id` and `trajectory_id`.
 * @returns the new fork session ID, or `undefined` on any validation or SQLite error.
 */
export function forkConversationDb(
  home: string,
  sourceSessionId: string,
  marks: ConversationHighWaterMarks,
  expectedFingerprint: string,
): string | undefined {
  if (!isValidMarks(marks)) return undefined
  const resolved = resolveSessionDbPath(home, sourceSessionId)
  if (resolved.kind !== 'ok') return undefined
  const forkId = randomUUID()
  const convDir = dirname(resolved.dbPath)
  const targetPath = join(convDir, `${forkId}.db`)

  let source: DatabaseSync | undefined
  let fork: DatabaseSync | undefined
  try {
    source = new DatabaseSync(resolved.dbPath, { readOnly: true, timeout: 100 })
    const sourceTables = presentTables(source)
    if (!assertIdentity(source, sourceTables, sourceSessionId)) return undefined
    source.prepare('VACUUM INTO ?').run(targetPath)
    source.close()
    source = undefined

    fork = new DatabaseSync(targetPath, { timeout: 100 })
    fork.exec('BEGIN IMMEDIATE')
    try {
      const forkTables = presentTables(fork)
      if (!assertIdentity(fork, forkTables, sourceSessionId)) {
        throw new Error('Conversation identity mismatch in forked DB')
      }
      const current = highWaterMarks(fork, forkTables)
      if (
        marks.steps > current.steps ||
        marks.generations > current.generations ||
        marks.executions > current.executions
      ) {
        throw new Error('Checkpoint exceeds forked conversation DB')
      }
      if (prefixFingerprint(fork, forkTables, marks) !== expectedFingerprint) {
        throw new Error('Forked conversation prefix fingerprint mismatch')
      }
      fork.prepare('DELETE FROM steps WHERE idx >= ?').run(marks.steps)
      if (forkTables.has('parent_references')) {
        fork
          .prepare('DELETE FROM parent_references WHERE idx >= ?')
          .run(marks.steps)
      }
      if (forkTables.has('gen_metadata')) {
        fork
          .prepare('DELETE FROM gen_metadata WHERE idx >= ?')
          .run(marks.generations)
      }
      if (forkTables.has('executor_metadata')) {
        fork
          .prepare('DELETE FROM executor_metadata WHERE idx >= ?')
          .run(marks.executions)
      }
      if (forkTables.has('battle_mode_infos')) {
        fork
          .prepare('DELETE FROM battle_mode_infos WHERE idx >= ?')
          .run(marks.steps)
      }
      fork
        .prepare(
          'UPDATE trajectory_meta SET cascade_id = ?, trajectory_id = ?',
        )
        .run(forkId, randomUUID())
      fork.exec('COMMIT')
    } catch (error) {
      try {
        fork.exec('ROLLBACK')
      } catch {
        // Ignore rollback failure on already-aborted transaction.
      }
      throw error
    }
    fork.close()
    fork = undefined
    return forkId
  } catch {
    source?.close()
    fork?.close()
    removeSessionArtifacts(home, forkId)
    return undefined
  }
}

/** Persistent checkpoint index stored atomically at `<home>/session-index.json`. */
export class SessionStore {
  private readonly home: string
  private readonly indexPath: string
  private checkpoints: PersistedCheckpoint[]

  constructor(home: string) {
    this.home = home
    this.indexPath = join(home, INDEX_FILE)
    this.checkpoints = this.load()
  }

  /** Whether any persisted checkpoint currently references `agySessionId`. */
  hasSession(agySessionId: string): boolean {
    return this.checkpoints.some((c) => c.agySessionId === agySessionId)
  }

  /** Distinct `agySessionId`s referenced by persisted checkpoints. */
  sessionIds(): Set<string> {
    return new Set(this.checkpoints.map((c) => c.agySessionId))
  }

  /** Return a snapshot of stored checkpoints (newest-first). */
  list(): readonly PersistedCheckpoint[] {
    return this.checkpoints
  }

  /** Record a new turn-end checkpoint and prune excess entries / orphaned DBs. */
  record(entry: PersistedCheckpoint): void {
    // Deduplicate identical (agySessionId, steps, generations, executions) snapshots.
    this.checkpoints = this.checkpoints.filter(
      (c) =>
        !(
          c.agySessionId === entry.agySessionId &&
          c.marks.steps === entry.marks.steps &&
          c.marks.generations === entry.marks.generations &&
          c.marks.executions === entry.marks.executions
        ),
    )
    this.checkpoints.unshift(entry)
    this.prune()
    this.save()
  }

  /**
   * Pin exact `completedIds` (including the emitted assistant message ID) onto
   * a matching checkpoint once a subsequent Pi turn reveals that ID.
   */
  pinCompletedIds(
    agySessionId: string,
    knownIds: readonly string[],
    completedIds: readonly string[],
  ): void {
    let changed = false
    for (const cp of this.checkpoints) {
      if (cp.agySessionId !== agySessionId) continue
      if (cp.completedIds !== undefined) continue
      if (
        cp.knownIds.length === knownIds.length &&
        cp.knownIds.every((id, i) => id === knownIds[i])
      ) {
        cp.completedIds = [...completedIds]
        changed = true
      }
    }
    if (changed) this.save()
  }

  /** Remove all checkpoints for a specific broken/dirty `agySessionId`. */
  forgetSession(agySessionId: string): void {
    const before = this.checkpoints.length
    this.checkpoints = this.checkpoints.filter(
      (c) => c.agySessionId !== agySessionId,
    )
    if (this.checkpoints.length !== before) this.save()
  }

  /** Remove all persisted checkpoints and clean up every tracked session's SQLite artifacts. */
  clearAll(): void {
    const sessionIds = new Set(this.checkpoints.map((c) => c.agySessionId))
    this.checkpoints = []
    for (const id of sessionIds) {
      removeSessionArtifacts(this.home, id)
    }
    try {
      unlinkSync(this.indexPath)
    } catch {
      // Ignore missing index file.
    }
  }

  /**
   * Find the best (longest-prefix, preferring same `piSessionKey`) persisted
   * checkpoint that cleanly precedes `messages` for `session/resume` or
   * `VACUUM INTO` copy-on-rewind forking.
   */
  findMatch(
    systemHash: string,
    messages: readonly RequestMessage[],
    provider: string,
    piSessionKey: string,
  ): CheckpointMatch | undefined {
    let best:
      | {
          match: CheckpointMatch
          prefixLen: number
          sameKey: boolean
          updatedAt: number
        }
      | undefined

    for (const cp of this.checkpoints) {
      if (cp.systemHash !== systemHash) continue
      const candidate = matchCheckpoint(cp, messages, provider)
      if (candidate === undefined) continue
      const prefixLen = candidate.completedIds.length
      const sameKey = cp.piSessionKey === piSessionKey
      if (
        best === undefined ||
        prefixLen > best.prefixLen ||
        (prefixLen === best.prefixLen && sameKey && !best.sameKey) ||
        (prefixLen === best.prefixLen &&
          sameKey === best.sameKey &&
          cp.updatedAt > best.updatedAt)
      ) {
        best = {
          match: candidate,
          prefixLen,
          sameKey,
          updatedAt: cp.updatedAt,
        }
      }
    }
    return best?.match
  }

  private prune(): void {
    const beforeIds = new Set(this.checkpoints.map((c) => c.agySessionId))
    // Keep at most MAX_PERSISTED_SESSIONS distinct agySessionIds (most recently updated first).
    const keptSessions = new Set<string>()
    const kept: PersistedCheckpoint[] = []
    for (const cp of this.checkpoints) {
      if (kept.length >= MAX_CHECKPOINTS) break
      if (
        !keptSessions.has(cp.agySessionId) &&
        keptSessions.size >= MAX_PERSISTED_SESSIONS
      ) {
        continue
      }
      keptSessions.add(cp.agySessionId)
      kept.push(cp)
    }
    this.checkpoints = kept
    for (const id of beforeIds) {
      if (!keptSessions.has(id)) {
        removeSessionArtifacts(this.home, id)
      }
    }
  }

  private load(): PersistedCheckpoint[] {
    if (!existsSync(this.indexPath)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter((cp) => {
        if (!isPersistedCheckpoint(cp)) return false
        const resolved = resolveSessionDbPath(this.home, cp.agySessionId)
        return resolved.kind === 'ok' && existsSync(resolved.dbPath)
      })
    } catch {
      return []
    }
  }

  private save(): void {
    const dir = dirname(this.indexPath)
    const tempPath = join(
      dir,
      `.${basename(this.indexPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`,
    )
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(tempPath, `${JSON.stringify(this.checkpoints, null, 2)}\n`, {
        mode: 0o600,
      })
      renameSync(tempPath, this.indexPath)
    } catch {
      try {
        unlinkSync(tempPath)
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

function matchCheckpoint(
  cp: PersistedCheckpoint,
  messages: readonly RequestMessage[],
  provider: string,
): CheckpointMatch | undefined {
  // Fast path: exact completedIds (includes the assistant message produced by this checkpoint).
  if (cp.completedIds !== undefined && cp.completedIds.length > 0) {
    if (cp.completedIds.length >= messages.length) return undefined
    for (let i = 0; i < cp.completedIds.length; i++) {
      if (messages[i]?.id !== cp.completedIds[i]) return undefined
    }
    const rest = messages.slice(cp.completedIds.length)
    if (
      rest.length > 0 &&
      rest.every((m) => m.role === 'user' || m.role === 'system')
    ) {
      return { checkpoint: cp, input: rest, completedIds: cp.completedIds }
    }
    return undefined
  }

  // First-resume path: knownIds + verified own assistant message matching finalTextHash.
  if (cp.knownIds.length === 0 || cp.knownIds.length + 1 >= messages.length) {
    return undefined
  }
  for (let i = 0; i < cp.knownIds.length; i++) {
    if (messages[i]?.id !== cp.knownIds[i]) return undefined
  }
  const trailingAssistant = messages[cp.knownIds.length]
  if (
    trailingAssistant?.role !== 'assistant' ||
    trailingAssistant.id === undefined ||
    trailingAssistant.source.kind !== 'model' ||
    trailingAssistant.source.provider !== provider
  ) {
    return undefined
  }
  if (digest(textOf(trailingAssistant.content)) !== cp.finalTextHash) {
    return undefined
  }
  const rest = messages.slice(cp.knownIds.length + 1)
  if (
    rest.length > 0 &&
    rest.every((m) => m.role === 'user' || m.role === 'system')
  ) {
    return {
      checkpoint: cp,
      input: rest,
      completedIds: [...cp.knownIds, trailingAssistant.id],
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false
  return Object.values(value).every((v) => typeof v === 'string')
}

function isPersistedCheckpoint(value: unknown): value is PersistedCheckpoint {
  if (!isRecord(value)) return false
  if (
    typeof value.agySessionId !== 'string' ||
    typeof value.piSessionKey !== 'string' ||
    typeof value.systemHash !== 'string' ||
    typeof value.finalTextHash !== 'string' ||
    typeof value.dbFingerprint !== 'string' ||
    typeof value.updatedAt !== 'number'
  ) {
    return false
  }
  if (!isStringArray(value.knownIds) || !isStringArray(value.issuedIds)) {
    return false
  }
  if (
    value.completedIds !== undefined &&
    !isStringArray(value.completedIds)
  ) {
    return false
  }
  if (
    !isStringRecord(value.advertisedToolDigests) ||
    !isStringRecord(value.knownTools)
  ) {
    return false
  }
  if (!isRecord(value.marks)) return false
  const marks: ConversationHighWaterMarks = {
    steps: Number(value.marks.steps),
    generations: Number(value.marks.generations),
    executions: Number(value.marks.executions),
  }
  return isValidMarks(marks)
}
