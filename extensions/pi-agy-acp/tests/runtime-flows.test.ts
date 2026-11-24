import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import type { AcpChild, AcpSpawner } from '../src/acp-process.ts'
import { defaults } from '../src/config.ts'
import type { GenerateOptions, RequestMessage, StreamChunk } from '../src/protocol.ts'
import { AntigravityRuntime } from '../src/runtime.ts'

interface FakeRpcMessage {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string }
}

interface FakeAgentHandlers {
  version?: string
  supportsResume?: boolean
  configOptions?: Array<Record<string, unknown>>
  onPrompt: (ctx: {
    sessionId: string
    prompt: unknown[]
    mcpUrl: string | undefined
    mcpAuth: string | undefined
    sendUpdate: (update: Record<string, unknown>) => void
    sendPermission: (req: Record<string, unknown>) => Promise<unknown>
    waitForCancel: Promise<void>
    reply: (result: Record<string, unknown>) => void
  }) => Promise<void> | void
}

interface FakeAcpHarness {
  spawner: AcpSpawner
  methodsCalled: string[]
  setConfigCalls: Array<{ sessionId: string; configId: string; value: string }>
  promptsReceived: Array<{ sessionId: string; prompt: unknown[] }>
  resumedSessions: string[]
  newSessions: string[]
  cancels: string[]
  sessionIds: string[]
  writeDbStep: (sessionId: string, label: string) => void
}

function createFakeAcp(home: string, handlers: FakeAgentHandlers): FakeAcpHarness {
  const methodsCalled: string[] = []
  const setConfigCalls: Array<{ sessionId: string; configId: string; value: string }> = []
  const promptsReceived: Array<{ sessionId: string; prompt: unknown[] }> = []
  const resumedSessions: string[] = []
  const newSessions: string[] = []
  const cancels: string[] = []
  const sessionIds: string[] = []

  const ensureDb = (sessionId: string) => {
    const convDir = join(home, 'agy', 'conversations')
    mkdirSync(convDir, { recursive: true })
    const dbPath = join(convDir, `${sessionId}.db`)
    const db = new DatabaseSync(dbPath)
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS trajectory_meta (
        trajectory_id TEXT PRIMARY KEY,
        cascade_id TEXT,
        trajectory_type INTEGER,
        source INTEGER
      );
      CREATE TABLE IF NOT EXISTS steps (
        idx INTEGER PRIMARY KEY,
        step_type INTEGER NOT NULL DEFAULT 0,
        status INTEGER NOT NULL DEFAULT 0,
        step_payload BLOB
      );
      CREATE TABLE IF NOT EXISTS parent_references (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `)
    const existing = db.prepare('SELECT count(*) AS c FROM trajectory_meta').get() as { c: number }
    if (existing.c === 0) {
      db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 4, 17)').run(randomUUID(), sessionId)
    }
    db.close()
  }

  const writeDbStep = (sessionId: string, label: string) => {
    ensureDb(sessionId)
    const db = new DatabaseSync(join(home, 'agy', 'conversations', `${sessionId}.db`))
    const row = db.prepare('SELECT coalesce(max(idx) + 1, 0) AS next FROM steps').get() as { next: number }
    db.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, 15, 3, ?)').run(
      row.next,
      Buffer.from(label),
    )
    const mrow = db.prepare('SELECT coalesce(max(idx) + 1, 0) AS next FROM gen_metadata').get() as { next: number }
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, 4)').run(
      mrow.next,
      Buffer.from(label),
    )
    db.close()
  }

  const spawner: AcpSpawner = () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    let resolveExit!: (v: { code: number | null; signal: string | null }) => void
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => {
      resolveExit = r
    })
    const send = (msg: Record<string, unknown>) => {
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
    }
    let nextAgentReqId = 1000
    const pendingAgentReqs = new Map<number, (v: unknown) => void>()
    const mcpBySession = new Map<string, { url?: string; auth?: string }>()
    const cancelResolvers = new Map<string, () => void>()

    const configOptions = handlers.configOptions ?? [
      {
        id: 'model',
        category: 'model',
        currentValue: 'gemini-4-neon',
        options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
      },
      {
        id: 'thought_level',
        category: 'thought_level',
        currentValue: 'high',
        options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
      },
    ]

    let buf = ''
    stdin.setEncoding('utf8')
    stdin.on('data', (chunk: string) => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const msg = JSON.parse(line) as FakeRpcMessage
        if (msg.method === undefined && msg.id !== undefined) {
          const resolver = pendingAgentReqs.get(msg.id)
          if (resolver) {
            pendingAgentReqs.delete(msg.id)
            resolver(msg.result)
          }
          continue
        }
        const method = msg.method ?? ''
        methodsCalled.push(method)
        const params = msg.params ?? {}

        if (method === 'initialize') {
          send({
            id: msg.id,
            result: {
              protocolVersion: 1,
              agentInfo: {
                name: 'Fake Agy ACP',
                version: handlers.version ?? '1.5.16',
              },
              agentCapabilities: {
                loadSession: true,
                promptCapabilities: { image: true },
                sessionCapabilities:
                  handlers.supportsResume === false ? { load: {} } : { resume: {}, load: {} },
              },
            },
          })
          continue
        }

        if (method === 'session/new') {
          const sid = randomUUID()
          sessionIds.push(sid)
          newSessions.push(sid)
          ensureDb(sid)
          const servers = (params.mcpServers as Array<{ url?: string; headers?: Array<{ name: string; value: string }> }>) ?? []
          const srv = servers[0]
          mcpBySession.set(sid, {
            url: srv?.url,
            auth: srv?.headers?.find((h) => h.name === 'Authorization')?.value,
          })
          send({
            id: msg.id,
            result: { sessionId: sid, configOptions },
          })
          continue
        }

        if (method === 'session/resume' || method === 'session/load') {
          const sid = String(params.sessionId)
          resumedSessions.push(sid)
          const servers = (params.mcpServers as Array<{ url?: string; headers?: Array<{ name: string; value: string }> }>) ?? []
          const srv = servers[0]
          mcpBySession.set(sid, {
            url: srv?.url,
            auth: srv?.headers?.find((h) => h.name === 'Authorization')?.value,
          })
          send({
            id: msg.id,
            result: { sessionId: sid, configOptions },
          })
          continue
        }

        if (method === 'session/set_config_option') {
          const sid = String(params.sessionId)
          const configId = String(params.configId)
          const value = String(params.value)
          setConfigCalls.push({ sessionId: sid, configId, value })
          const updated = configOptions.map((o) =>
            o.id === configId ? { ...o, currentValue: value } : o,
          )
          send({ id: msg.id, result: { configOptions: updated } })
          continue
        }

        if (method === 'session/close') {
          send({ id: msg.id, result: {} })
          continue
        }

        if (method === 'session/cancel') {
          const sid = String(params.sessionId)
          cancels.push(sid)
          cancelResolvers.get(sid)?.()
          cancelResolvers.delete(sid)
          continue
        }

        if (method === 'session/prompt') {
          const sid = String(params.sessionId)
          const prompt = (params.prompt as unknown[]) ?? []
          promptsReceived.push({ sessionId: sid, prompt })
          const mcp = mcpBySession.get(sid)
          const waitForCancel = new Promise<void>((r) => {
            cancelResolvers.set(sid, r)
          })
          let replied = false
          const reply = (result: Record<string, unknown>) => {
            if (replied) return
            replied = true
            send({ id: msg.id, result })
          }
          const sendUpdate = (update: Record<string, unknown>) => {
            send({ method: 'session/update', params: { sessionId: sid, update } })
          }
          const sendPermission = (req: Record<string, unknown>) =>
            new Promise((resolve) => {
              const id = ++nextAgentReqId
              pendingAgentReqs.set(id, resolve)
              send({ id, method: 'session/request_permission', params: { sessionId: sid, ...req } })
            })
          void Promise.resolve(
            handlers.onPrompt({
              sessionId: sid,
              prompt,
              mcpUrl: mcp?.url,
              mcpAuth: mcp?.auth,
              sendUpdate,
              sendPermission,
              waitForCancel,
              reply,
            }),
          )
        }
      }
    })

    const child: AcpChild = {
      stdin,
      stdout,
      exited,
      stderrTail: () => '',
      terminate: () => {
        stdout.end()
        resolveExit({ code: 0, signal: null })
      },
    }
    return child
  }

  return {
    spawner,
    methodsCalled,
    setConfigCalls,
    promptsReceived,
    resumedSessions,
    newSessions,
    cancels,
    sessionIds,
    writeDbStep,
  }
}

async function mcpPost(
  url: string,
  auth: string | undefined,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...body }),
  })
  const text = await res.text()
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const dataLine = text
      .split('\n')
      .find((l) => l.startsWith('data: '))
    return dataLine ? (JSON.parse(dataLine.slice(6)) as Record<string, unknown>) : {}
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

async function collectChunks(
  gen: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of gen) out.push(chunk)
  return out
}

function makeFakeBinary(home: string): string {
  const bin = join(home, 'fake-agy')
  writeFileSync(bin, '#!/bin/sh\necho 1.5.16\n', { mode: 0o755 })
  return bin
}

function makeRuntime(
  home: string,
  bin: string,
  spawner: AcpSpawner,
  extra: Partial<{ detachAfterMs: number; cancelTimeoutMs: number }> = {},
): AntigravityRuntime {
  return new AntigravityRuntime({
    config: {
      ...defaults,
      command: bin,
      home,
      parkSettleMs: 10,
      ...(extra.detachAfterMs !== undefined ? { detachAfterMs: extra.detachAfterMs } : {}),
      ...(extra.cancelTimeoutMs !== undefined ? { cancelTimeoutMs: extra.cancelTimeoutMs } : {}),
    },
    spawnAcp: spawner,
    runCommand: async () => ({ code: 0, stdout: '1.5.16\n', stderr: '' }),
    log: { info: () => {}, warn: () => {} },
    onModelsChanged: () => {},
  })
}

describe('AntigravityRuntime end-to-end upgraded flows', () => {
  it('omits pi_await_result, validates MCP tool args at boundary, and handles effort-suffixed models', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-agy-rt1-'))
    const bin = makeFakeBinary(home)
    let listedTools: string[] = []
    let invalidCallResult: Record<string, unknown> | undefined

    const fake = createFakeAcp(home, {
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'gemini-4-hydrogen-low',
          options: [
            { value: 'gemini-4-hydrogen-low', name: 'Gemini 4 Hydrogen (Low)' },
            { value: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
          ],
        },
        {
          id: 'thought_level',
          category: 'thought_level',
          currentValue: 'low',
          options: [{ value: 'low' }, { value: 'high' }],
        },
      ],
      onPrompt: async ({ mcpUrl, mcpAuth, sendUpdate, reply }) => {
        assert.ok(mcpUrl)
        const listResp = await mcpPost(mcpUrl, mcpAuth, {
          id: 1,
          method: 'tools/list',
          params: {},
        })
        const tools = ((listResp.result as { tools?: Array<{ name: string }> })?.tools ?? [])
        listedTools = tools.map((t) => t.name)

        // Call `read` with invalid argument type (number instead of string) -> rejected at MCP boundary!
        invalidCallResult = await mcpPost(mcpUrl, mcpAuth, {
          id: 2,
          method: 'tools/call',
          params: { name: 'read', arguments: { path: 42 } },
        })

        sendUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Handled validation cleanly.' },
        })
        reply({ stopReason: 'end_turn' })
      },
    })

    const runtime = makeRuntime(home, bin, fake.spawner)
    try {
      const req: GenerateOptions = {
        model: 'gemini-4-hydrogen',
        reasoningEffort: 'high',
        sessionId: 'sess-val',
        system: 'sys',
        tools: [
          {
            name: 'read',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        ],
        messages: [
          { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        ],
      }
      const chunks = await collectChunks(runtime.stream(req))
      assert.ok(listedTools.includes('read'))
      assert.ok(listedTools.includes('pi_call_tool'))
      assert.ok(!listedTools.includes('pi_await_result'))

      const mcpRes = invalidCallResult?.result as {
        isError?: boolean
        content?: Array<{ text: string }>
      }
      assert.equal(mcpRes?.isError, true)
      assert.match(mcpRes?.content?.[0]?.text ?? '', /\$\.path: expected string, got integer/)

      // No tool-call chunk leaked to Pi!
      assert.equal(
        chunks.some((c) => c.type === 'block-start' && c.blockType === 'tool-call'),
        false,
      )
      assert.ok(
        chunks.some((c) => c.type === 'finish' && c.reason.kind === 'stop'),
      )

      // Model switched to `gemini-4-hydrogen-high` and skipped `thought_level` write!
      assert.deepEqual(
        fake.setConfigCalls.map((c) => `${c.configId}=${c.value}`),
        ['model=gemini-4-hydrogen-high'],
      )
    } finally {
      await runtime.dispose({ purgeArtifacts: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('detaches long-running tools via cancel-and-drain and delivers real result + image in fresh turn', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-agy-rt2-'))
    const bin = makeFakeBinary(home)
    let promptCount = 0
    let mcpDetachResp: Record<string, unknown> | undefined

    const fake = createFakeAcp(home, {
      onPrompt: async ({ mcpUrl, mcpAuth, sendUpdate, waitForCancel, reply }) => {
        promptCount++
        if (promptCount === 1) {
          assert.ok(mcpUrl)
          // Start a tool call that Pi will hold longer than detachAfterMs (60ms).
          const callPromise = mcpPost(mcpUrl, mcpAuth, {
            id: 1,
            method: 'tools/call',
            params: { name: 'slow_tool', arguments: { cmd: 'build' } },
          })
          // Wait until runtime sends session/cancel, then confirm cancellation!
          await waitForCancel
          mcpDetachResp = await callPromise
          reply({ stopReason: 'cancelled' })
          return
        }
        // Prompt #2 receives the real detached tool result + image on the SAME session!
        sendUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Build succeeded after detach!' },
        })
        reply({ stopReason: 'end_turn' })
      },
    })

    const runtime = makeRuntime(home, bin, fake.spawner, {
      detachAfterMs: 60,
      cancelTimeoutMs: 2_000,
    })
    try {
      const baseTools = [
        {
          name: 'slow_tool',
          description: 'Slow build tool',
          parameters: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            required: ['cmd'],
          },
        },
      ]
      const u1: RequestMessage = {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: 'Run build' }],
      }
      const step1 = await collectChunks(
        runtime.stream({
          model: 'gemini-4-neon',
          sessionId: 'sess-detach',
          system: 'sys',
          tools: baseTools,
          messages: [u1],
        }),
      )
      const toolCall = step1.find(
        (c): c is Extract<StreamChunk, { type: 'block-end' }> =>
          c.type === 'block-end' && c.block.type === 'tool-call',
      )
      assert.ok(toolCall && toolCall.block.type === 'tool-call')
      const callId = toolCall.block.id

      // Hold longer than detachAfterMs so cancel-and-drain triggers!
      await new Promise((r) => setTimeout(r, 140))
      assert.equal(fake.cancels.length, 1)
      const detachContent = (
        mcpDetachResp?.result as { isError?: boolean; content?: Array<{ text: string }> }
      )
      assert.equal(detachContent?.isError, true)
      assert.match(detachContent?.content?.[0]?.text ?? '', /detached/i)

      // Now Pi finishes the slow tool (returning text + image) and delivers it!
      const step2 = await collectChunks(
        runtime.stream({
          model: 'gemini-4-neon',
          sessionId: 'sess-detach',
          system: 'sys',
          tools: baseTools,
          messages: [
            u1,
            {
              id: 'a1',
              role: 'assistant',
              source: { kind: 'model', provider: 'antigravity-acp' },
              content: [toolCall.block],
            },
            {
              id: 't1',
              role: 'tool',
              toolCallId: callId,
              content: [
                { type: 'text', text: 'OK: 0 errors' },
                { type: 'image', data: 'BUILD_PNG', mimeType: 'image/png' },
              ],
            },
          ],
        }),
      )
      assert.ok(
        step2.some((c) => c.type === 'text-delta' && c.text.includes('Build succeeded after detach!')),
      )
      // Same ACP session reused (no rebuild)!
      assert.equal(fake.newSessions.length, 1)
      assert.equal(fake.promptsReceived.length, 2)
      assert.equal(fake.promptsReceived[0]!.sessionId, fake.promptsReceived[1]!.sessionId)
      const prompt2Blocks = fake.promptsReceived[1]!.prompt as Array<{ type: string; data?: string; text?: string }>
      assert.ok(prompt2Blocks.some((b) => b.type === 'image' && b.data === 'BUILD_PNG'))
      assert.ok(prompt2Blocks.some((b) => b.type === 'text' && b.text?.includes('OK: 0 errors')))
    } finally {
      await runtime.dispose({ purgeArtifacts: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('supports native mid-turn steering (steersWithPrompt) when user steers while tool is parked', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-agy-rt3-'))
    const bin = makeFakeBinary(home)
    let promptCount = 0
    let replyPrompt1: ((r: Record<string, unknown>) => void) | undefined
    let parkedCallPromise: Promise<Record<string, unknown>> | undefined

    const fake = createFakeAcp(home, {
      version: '1.5.16',
      onPrompt: async ({ mcpUrl, mcpAuth, sendUpdate, reply }) => {
        promptCount++
        if (promptCount === 1) {
          assert.ok(mcpUrl)
          replyPrompt1 = reply
          parkedCallPromise = mcpPost(mcpUrl, mcpAuth, {
            id: 1,
            method: 'tools/call',
            params: { name: 'check', arguments: {} },
          })
          return
        }
        // Prompt #2 arrives as a mid-turn steer while prompt #1 is parked:
        // agy accepts prompt #2 by resolving prompt #1, then awaits the parked tool result!
        replyPrompt1?.({ stopReason: 'end_turn' })
        const toolResp = await parkedCallPromise
        const toolText = (
          toolResp?.result as { content?: Array<{ text: string }> }
        )?.content?.[0]?.text
        sendUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Steered with tool output: ${toolText}` },
        })
        reply({ stopReason: 'end_turn' })
      },
    })

    const runtime = makeRuntime(home, bin, fake.spawner)
    try {
      const baseTools = [
        {
          name: 'check',
          description: 'Check status',
          parameters: { type: 'object', properties: {} },
        },
      ]
      const u1: RequestMessage = {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: 'Check repo' }],
      }
      const step1 = await collectChunks(
        runtime.stream({
          model: 'gemini-4-neon',
          sessionId: 'sess-steer',
          system: 'sys',
          tools: baseTools,
          messages: [u1],
        }),
      )
      const toolCall = step1.find(
        (c): c is Extract<StreamChunk, { type: 'block-end' }> =>
          c.type === 'block-end' && c.block.type === 'tool-call',
      )
      assert.ok(toolCall && toolCall.block.type === 'tool-call')

      const step2 = await collectChunks(
        runtime.stream({
          model: 'gemini-4-neon',
          sessionId: 'sess-steer',
          system: 'sys',
          tools: baseTools,
          messages: [
            u1,
            {
              id: 'a1',
              role: 'assistant',
              source: { kind: 'model', provider: 'antigravity-acp' },
              content: [toolCall.block],
            },
            {
              id: 't1',
              role: 'tool',
              toolCallId: toolCall.block.id,
              content: [{ type: 'text', text: 'ALL GREEN' }],
            },
            {
              id: 'steer-u',
              role: 'user',
              content: [
                { type: 'text', text: 'Also check lint!' },
                { type: 'image', data: 'STEER_IMG', mimeType: 'image/png' },
              ],
            },
          ],
        }),
      )
      assert.ok(
        step2.some(
          (c) => c.type === 'text-delta' && c.text.includes('Steered with tool output: ALL GREEN'),
        ),
      )
      assert.equal(fake.promptsReceived.length, 2)
      const steerBlocks = fake.promptsReceived[1]!.prompt as Array<{ type: string; text?: string; data?: string }>
      assert.ok(steerBlocks.some((b) => b.type === 'text' && b.text === 'Also check lint!'))
      assert.ok(steerBlocks.some((b) => b.type === 'image' && b.data === 'STEER_IMG'))
    } finally {
      await runtime.dispose({ purgeArtifacts: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('persists checkpoints across restart (session/resume) and copy-on-rewind forks via VACUUM INTO', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-agy-rt4-'))
    const bin = makeFakeBinary(home)
    let turnNum = 0

    const makeFake = () =>
      createFakeAcp(home, {
        supportsResume: true,
        onPrompt: ({ sessionId, sendUpdate, reply }) => {
          turnNum++
          fakeRef.writeDbStep(sessionId, `turn-${turnNum}`)
          sendUpdate({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Answer ${turnNum}` },
          })
          reply({ stopReason: 'end_turn' })
        },
      })

    let fakeRef = makeFake()
    const rt1 = makeRuntime(home, bin, fakeRef.spawner)
    const u1: RequestMessage = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Turn 1' }] }
    const a1: RequestMessage = {
      id: 'a1',
      role: 'assistant',
      source: { kind: 'model', provider: 'antigravity-acp' },
      content: [{ type: 'text', text: 'Answer 1' }],
    }
    const u2: RequestMessage = { id: 'u2', role: 'user', content: [{ type: 'text', text: 'Turn 2' }] }
    const a2: RequestMessage = {
      id: 'a2',
      role: 'assistant',
      source: { kind: 'model', provider: 'antigravity-acp' },
      content: [{ type: 'text', text: 'Answer 2' }],
    }
    const u3: RequestMessage = { id: 'u3', role: 'user', content: [{ type: 'text', text: 'Turn 3 after restart' }] }
    const u2Branch: RequestMessage = { id: 'u2b', role: 'user', content: [{ type: 'text', text: 'Branched turn 2' }] }

    let origSessionId = ''
    try {
      // Turn 1 & Turn 2 on runtime #1.
      await collectChunks(
        rt1.stream({ model: 'gemini-4-neon', sessionId: 'pi-main', system: 'sys', messages: [u1] }),
      )
      await collectChunks(
        rt1.stream({ model: 'gemini-4-neon', sessionId: 'pi-main', system: 'sys', messages: [u1, a1, u2] }),
      )
      origSessionId = fakeRef.newSessions[0]!
      assert.ok(origSessionId)
      assert.equal(fakeRef.newSessions.length, 1)
    } finally {
      // Graceful shutdown (keeps checkpointed SQLite DB intact!).
      await rt1.dispose()
    }

    // Simulate Pi restart with a brand new AntigravityRuntime instance!
    fakeRef = makeFake()
    const rt2 = makeRuntime(home, bin, fakeRef.spawner)
    try {
      // Turn 3 after restart -> MUST use `session/resume` on origSessionId (0 session/new, no <pi_history>!).
      await collectChunks(
        rt2.stream({
          model: 'gemini-4-neon',
          sessionId: 'pi-main',
          system: 'sys',
          messages: [u1, a1, u2, a2, u3],
        }),
      )
      assert.equal(fakeRef.newSessions.length, 0)
      assert.deepEqual(fakeRef.resumedSessions, [origSessionId])
      const turn3PromptText = JSON.stringify(fakeRef.promptsReceived[0]!.prompt)
      assert.ok(!turn3PromptText.includes('<pi_history>'))
      assert.ok(turn3PromptText.includes('Turn 3 after restart'))

      // Now simulate Pi tree rewind back to Turn 1 (`[u1, a1, u2Branch]`)!
      // origSessionId is now at step 3 (ahead of Turn 1 checkpoint at step 1) ->
      // MUST fork via VACUUM INTO into a new forkId and call `session/resume` on forkId!
      await collectChunks(
        rt2.stream({
          model: 'gemini-4-neon',
          sessionId: 'pi-main',
          system: 'sys',
          messages: [u1, a1, u2Branch],
        }),
      )
      assert.equal(fakeRef.newSessions.length, 0)
      assert.equal(fakeRef.resumedSessions.length, 2)
      const forkSessionId = fakeRef.resumedSessions[1]!
      assert.notEqual(forkSessionId, origSessionId)
      const branchPromptText = JSON.stringify(fakeRef.promptsReceived[1]!.prompt)
      assert.ok(!branchPromptText.includes('<pi_history>'))
      assert.ok(branchPromptText.includes('Branched turn 2'))

      // Verify forked DB only had Turn 1 before Turn 4 ran (2 rows total: turn-1 + turn-4),
      // while origSessionId still has all 3 original turns untouched!
      const forkDb = new DatabaseSync(
        join(home, 'agy', 'conversations', `${forkSessionId}.db`),
        { readOnly: true },
      )
      const forkPayloads = (
        forkDb.prepare('SELECT step_payload FROM steps ORDER BY idx').all() as Array<{ step_payload: Uint8Array }>
      ).map((r) => Buffer.from(r.step_payload).toString('utf8'))
      forkDb.close()
      assert.deepEqual(forkPayloads, ['turn-1', 'turn-4'])

      const origDb = new DatabaseSync(
        join(home, 'agy', 'conversations', `${origSessionId}.db`),
        { readOnly: true },
      )
      const origPayloads = (
        origDb.prepare('SELECT step_payload FROM steps ORDER BY idx').all() as Array<{ step_payload: Uint8Array }>
      ).map((r) => Buffer.from(r.step_payload).toString('utf8'))
      origDb.close()
      assert.deepEqual(origPayloads, ['turn-1', 'turn-2', 'turn-3'])
    } finally {
      await rt2.dispose({ purgeArtifacts: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})
