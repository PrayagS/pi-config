import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import {
  forkConversationDb,
  inspectConversationState,
  readConversationCheckpoint,
  SessionStore,
} from '../src/session-store.ts'
import type { RequestMessage } from '../src/protocol.ts'
import { digest } from '../src/util.ts'

function createAgyDb(home: string, sessionId: string): string {
  const convDir = join(home, 'agy', 'conversations')
  mkdirSync(convDir, { recursive: true })
  const dbPath = join(convDir, `${sessionId}.db`)
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE trajectory_meta (
      trajectory_id TEXT PRIMARY KEY,
      cascade_id TEXT,
      trajectory_type INTEGER,
      source INTEGER
    );
    CREATE TABLE steps (
      idx INTEGER PRIMARY KEY,
      step_type INTEGER NOT NULL DEFAULT 0,
      status INTEGER NOT NULL DEFAULT 0,
      step_payload BLOB
    );
    CREATE TABLE parent_references (
      idx INTEGER PRIMARY KEY,
      data BLOB
    );
    CREATE TABLE gen_metadata (
      idx INTEGER PRIMARY KEY,
      data BLOB,
      size INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE executor_metadata (
      idx INTEGER PRIMARY KEY,
      data BLOB
    );
    CREATE TABLE battle_mode_infos (
      idx INTEGER PRIMARY KEY,
      data BLOB
    );
  `)
  db.prepare(
    'INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, 4, 17)',
  ).run('traj-1', sessionId)
  db.prepare(
    'INSERT INTO steps (idx, step_type, status, step_payload) VALUES (0, 14, 3, ?), (1, 15, 3, ?)',
  ).run(Buffer.from('turn1-input'), Buffer.from('turn1-output'))
  db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, 10)').run(
    Buffer.from('meta-0'),
  )
  // Intentionally leave executor_metadata empty (0 rows), matching live agy 1.5.16.
  db.close()
  return dbPath
}

describe('SQLite checkpoints and VACUUM INTO copy-on-rewind forks', () => {
  it('snapshots WAL DBs with 0 executor_metadata rows, detects advance, and forks cleanly', () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-agy-store-'))
    try {
      const sourceId = '11111111-1111-4111-8111-111111111111'
      const dbPath = createAgyDb(home, sourceId)

      const cp1 = readConversationCheckpoint(home, sourceId)
      assert.ok(cp1)
      assert.deepEqual(cp1.marks, { steps: 2, generations: 1, executions: 0 })

      assert.equal(
        inspectConversationState(home, sourceId, cp1.marks, cp1.dbFingerprint),
        'exact',
      )

      // Advance the source DB with Turn 2 rows (while in WAL mode).
      const db = new DatabaseSync(dbPath)
      db.prepare(
        'INSERT INTO steps (idx, step_type, status, step_payload) VALUES (2, 14, 3, ?), (3, 15, 3, ?)',
      ).run(Buffer.from('turn2-input'), Buffer.from('turn2-output'))
      db.prepare(
        'INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, 12)',
      ).run(Buffer.from('meta-1'))
      db.close()

      // Checkpoint 1 is now strictly behind current DB -> 'ahead' (requires fork).
      assert.equal(
        inspectConversationState(home, sourceId, cp1.marks, cp1.dbFingerprint),
        'ahead',
      )

      // Fork back to checkpoint 1 via VACUUM INTO.
      const forkId = forkConversationDb(
        home,
        sourceId,
        cp1.marks,
        cp1.dbFingerprint,
      )
      assert.ok(forkId)
      assert.notEqual(forkId, sourceId)

      // Fork matches checkpoint 1 exactly and has its own cascade_id & trajectory_id.
      assert.equal(
        inspectConversationState(home, forkId, cp1.marks, cp1.dbFingerprint),
        'exact',
      )
      const forkDb = new DatabaseSync(
        join(home, 'agy', 'conversations', `${forkId}.db`),
        { readOnly: true },
      )
      const meta = forkDb
        .prepare('SELECT cascade_id, trajectory_id FROM trajectory_meta')
        .get() as { cascade_id: string; trajectory_id: string }
      assert.equal(meta.cascade_id, forkId)
      assert.notEqual(meta.trajectory_id, 'traj-1')
      const forkSteps = forkDb
        .prepare('SELECT idx FROM steps ORDER BY idx')
        .all() as { idx: number }[]
      assert.deepEqual(
        forkSteps.map((r) => r.idx),
        [0, 1],
      )
      forkDb.close()

      // Source DB still has all 4 steps untouched!
      const srcDb = new DatabaseSync(dbPath, { readOnly: true })
      const srcSteps = srcDb
        .prepare('SELECT idx FROM steps ORDER BY idx')
        .all() as { idx: number }[]
      assert.deepEqual(
        srcSteps.map((r) => r.idx),
        [0, 1, 2, 3],
      )
      srcDb.close()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('fails closed when prefix bytes were tampered with', () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-agy-tamper-'))
    try {
      const sourceId = '22222222-2222-4222-8222-222222222222'
      const dbPath = createAgyDb(home, sourceId)
      const cp = readConversationCheckpoint(home, sourceId)
      assert.ok(cp)

      // Mutate step 0 payload in-place.
      const db = new DatabaseSync(dbPath)
      db.prepare('UPDATE steps SET step_payload = ? WHERE idx = 0').run(
        Buffer.from('corrupted'),
      )
      db.close()

      assert.equal(
        inspectConversationState(home, sourceId, cp.marks, cp.dbFingerprint),
        'mismatch',
      )
      assert.equal(
        forkConversationDb(home, sourceId, cp.marks, cp.dbFingerprint),
        undefined,
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('SessionStore checkpoint matching and lifecycle', () => {
  it('matches first-resume via finalTextHash, pins completedIds, and selects longest rewind prefix', () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-agy-idx-'))
    try {
      const store = new SessionStore(home)
      const systemHash = digest('sys-prompt')
      const sessionId = '33333333-3333-4333-8333-333333333333'
      createAgyDb(home, sessionId)
      const snap = readConversationCheckpoint(home, sessionId)
      assert.ok(snap)

      store.record({
        agySessionId: sessionId,
        piSessionKey: 'pi-sess-1',
        systemHash,
        knownIds: ['u1'],
        finalTextHash: digest('Hello from turn 1'),
        issuedIds: [],
        advertisedToolDigests: {},
        knownTools: {},
        marks: snap.marks,
        dbFingerprint: snap.dbFingerprint,
        updatedAt: 1000,
      })

      const messages: RequestMessage[] = [
        { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        {
          id: 'a1',
          role: 'assistant',
          source: { kind: 'model', provider: 'antigravity-acp' },
          content: [{ type: 'text', text: 'Hello from turn 1' }],
        },
        { id: 'u2', role: 'user', content: [{ type: 'text', text: 'Next' }] },
      ]

      const match = store.findMatch(
        systemHash,
        messages,
        'antigravity-acp',
        'pi-sess-1',
      )
      assert.ok(match)
      assert.equal(match.checkpoint.agySessionId, sessionId)
      assert.deepEqual(match.completedIds, ['u1', 'a1'])
      assert.deepEqual(
        match.input.map((m) => m.id),
        ['u2'],
      )

      // Wrong assistant text must NOT match.
      const tamperedMessages: RequestMessage[] = [
        messages[0]!,
        {
          id: 'a1-edited',
          role: 'assistant',
          source: { kind: 'model', provider: 'antigravity-acp' },
          content: [{ type: 'text', text: 'Different text' }],
        },
        messages[2]!,
      ]
      assert.equal(
        store.findMatch(
          systemHash,
          tamperedMessages,
          'antigravity-acp',
          'pi-sess-1',
        ),
        undefined,
      )

      // Reload from disk and verify persistence + clearAll cleanup.
      const reloaded = new SessionStore(home)
      assert.equal(reloaded.hasSession(sessionId), true)
      reloaded.clearAll()
      assert.equal(reloaded.hasSession(sessionId), false)
      assert.equal(
        existsSync(join(home, 'agy', 'conversations', `${sessionId}.db`)),
        false,
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
