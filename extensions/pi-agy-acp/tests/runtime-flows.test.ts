import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough } from 'node:stream'
import { describe, it, type TestContext } from 'node:test'
import type { AcpChild, AcpSpawner } from '../src/acp-process.ts'
import { defaults, type Config } from '../src/config.ts'
import type { GenerateOptions, RequestMessage, StreamChunk } from '../src/protocol.ts'
import { AntigravityRuntime, type RuntimeHost } from '../src/runtime.ts'

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
  newSessionCwds: unknown[]
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
  const newSessionCwds: unknown[] = []
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
          newSessionCwds.push(params.cwd)
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
    newSessionCwds,
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
  extra: Partial<Pick<Config, 'detachAfterMs' | 'cancelTimeoutMs' | 'nativeWriteRoot'>> = {},
  onNativeWrite?: RuntimeHost['onNativeWrite'],
): AntigravityRuntime {
  return new AntigravityRuntime({
    config: {
      ...defaults,
      command: bin,
      home,
      parkSettleMs: 10,
      ...extra,
    },
    spawnAcp: spawner,
    runCommand: async () => ({ code: 0, stdout: '1.5.16\n', stderr: '' }),
    log: { info: () => {}, warn: () => {} },
    onModelsChanged: () => {},
    ...(onNativeWrite === undefined ? {} : { onNativeWrite }),
  })
}

const piFileTools = ['read', 'edit', 'write'].map((name) => ({
  name,
  description: `Pi ${name}`,
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: name === 'write' ? ['path', 'content'] : ['path'],
  },
}))

function nativeWriteFixture(
  t: TestContext,
  onPrompt: FakeAgentHandlers['onPrompt'],
  enabled = true,
  onNativeWrite?: RuntimeHost['onNativeWrite'],
) {
  const home = mkdtempSync(join(tmpdir(), 'pi-agy-native-'))
  const workspace = join(home, 'workspace')
  const workspaceAlias = join(home, 'workspace-alias')
  const outside = join(home, 'workspace-outside')
  mkdirSync(workspace)
  mkdirSync(outside)
  symlinkSync(workspace, workspaceAlias, 'dir')
  const fake = createFakeAcp(home, { onPrompt })
  const runtime = makeRuntime(home, makeFakeBinary(home), fake.spawner, {
    ...(enabled ? { nativeWriteRoot: workspaceAlias } : {}),
  }, onNativeWrite)
  t.after(async () => {
    try {
      await runtime.dispose({ purgeArtifacts: true })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  return { fake, runtime, workspace: realpathSync(workspace), outside: realpathSync(outside) }
}

const nativeWriteOptions = [
  { kind: 'allow_always', optionId: 'always' },
  { kind: 'allow_once', optionId: 'once' },
  { kind: 'reject_once', optionId: 'reject' },
]
const allowOnce = { outcome: { outcome: 'selected', optionId: 'once' } }
const rejectOnce = { outcome: { outcome: 'selected', optionId: 'reject' } }

function nativeFileCall(name: string, path: string, field: 'Path' | 'TargetFile' = 'TargetFile') {
  return { name, kind: 'edit', rawInput: { [field]: path }, locations: [{ path }] }
}

type PromptContext = Parameters<FakeAgentHandlers['onPrompt']>[0]

function finishFakeTurn(ctx: PromptContext) {
  ctx.sendUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } })
  ctx.reply({ stopReason: 'end_turn' })
}

function askToolPermission(
  ctx: PromptContext,
  toolCall: Record<string, unknown>,
  report: Record<string, unknown> | null = toolCall,
  toolCallId = randomUUID(),
): Promise<unknown> {
  if (report !== null) {
    ctx.sendUpdate({ sessionUpdate: 'tool_call', status: 'pending', toolCallId, ...report })
  }
  return ctx.sendPermission({ toolCall: { toolCallId, ...toolCall }, options: nativeWriteOptions })
}

const nativeWriteRequest = {
  model: 'gemini-4-neon',
  sessionId: 'sess-native-write',
  system: 'sys',
  tools: piFileTools,
}
const nativeWriteInput: RequestMessage = {
  id: 'u1', role: 'user', content: [{ type: 'text', text: 'Update the workspace' }],
}

describe('AntigravityRuntime native write opt-in', () => {
  it('filters Pi edit/write from MCP and dynamic schemas without removing read or other tools', async (t) => {
    let listedTools: string[] = []
    const mcpWriteResults: Record<string, unknown>[] = []
    let mcpError: unknown
    const otherTool = { name: 'check', description: 'Check files', parameters: { type: 'object' } }
    const tools = [...piFileTools, otherTool]
    const { fake, runtime, workspace } = nativeWriteFixture(t, async (ctx) => {
      const { mcpUrl, mcpAuth } = ctx
      if (fake.promptsReceived.length === 1 && mcpUrl !== undefined) {
        try {
          const list = await mcpPost(mcpUrl, mcpAuth, { id: 1, method: 'tools/list', params: {} })
          listedTools = (list.result as { tools?: Array<{ name: string }> })?.tools?.map((tool) => tool.name) ?? []
          const write = { name: 'write', arguments: { path: join(workspace, 'new.txt'), content: 'hello' } }
          for (const params of [write, { name: 'pi_call_tool', arguments: write }]) {
            mcpWriteResults.push(await mcpPost(mcpUrl, mcpAuth, { id: 2, method: 'tools/call', params }))
          }
        } catch (error) {
          mcpError = error
        }
      }
      finishFakeTurn(ctx)
    })

    const first = await collectChunks(runtime.stream({ ...nativeWriteRequest, tools, messages: [nativeWriteInput] }))
    assert.equal(mcpError, undefined)
    assert.deepEqual(listedTools.sort(), ['check', 'pi_call_tool', 'read'])
    assert.ok(first.some((c) => c.type === 'finish' && c.reason.kind === 'stop'))
    assert.equal(mcpWriteResults.length, 2)
    for (const response of mcpWriteResults) {
      const result = response.result as { isError?: boolean; content?: Array<{ text: string }> }
      assert.equal(result?.isError, true)
      assert.match(result?.content?.[0]?.text ?? '', /(?:no|unknown).*tool.*write/i)
    }
    assert.ok(!first.some((c) => c.type === 'block-start' && c.blockType === 'tool-call'))
    assert.deepEqual(fake.newSessionCwds, [workspace])

    await collectChunks(runtime.stream({
      ...nativeWriteRequest,
      tools: tools.map((tool) => ({ ...tool, description: `${tool.description} (updated)` })),
      messages: [
        nativeWriteInput,
        { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'antigravity-acp' }, content: [{ type: 'text', text: 'Done' }] },
        { id: 'u2', role: 'user', content: [{ type: 'text', text: 'Continue' }] },
      ],
    }))
    assert.deepEqual(fake.promptsReceived.map((p) => p.sessionId), [fake.newSessions[0], fake.newSessions[0]])
    const update = fake.promptsReceived[1]!.prompt.find(
      (block): block is { type: 'text'; text: string } =>
        (block as { text?: string }).text?.startsWith('<harness_tool_update>') === true,
    )
    assert.ok(update)
    assert.match(update.text, /"name":"read"/)
    assert.match(update.text, /"name":"check"/)
    assert.doesNotMatch(update.text, /"name":"(?:write|edit)"/)
  })

  it('reports one completed native edit with its pending diff without emitting a Pi tool call', async (t) => {
    const activities: Parameters<NonNullable<RuntimeHost['onNativeWrite']>>[] = []
    const toolCallId = 'native-edit-1'
    const diff = { oldText: 'old\n', newText: 'new\n' }
    const { runtime, workspace } = nativeWriteFixture(t, (ctx) => {
      ctx.sendUpdate({
        sessionUpdate: 'tool_call',
        toolCallId,
        status: 'pending',
        ...nativeFileCall('edit_file', path, 'Path'),
        content: [{ type: 'diff', path, ...diff }],
      })
      const completed = { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' }
      ctx.sendUpdate(completed)
      ctx.sendUpdate(completed)
      finishFakeTurn(ctx)
    }, true, (sessionId, activity) => activities.push([sessionId, activity]))
    const path = join(workspace, 'existing.txt')
    writeFileSync(path, diff.oldText)

    const chunks = await collectChunks(runtime.stream({ ...nativeWriteRequest, messages: [nativeWriteInput] }))
    assert.deepEqual(activities, [[nativeWriteRequest.sessionId, {
      toolCallId, name: 'edit_file', status: 'completed', path, diff,
    }]])
    assert.ok(chunks.some((c) => c.type === 'finish' && c.reason.kind === 'stop'))
    assert.ok(!chunks.some((c) => c.type === 'block-start' && c.blockType === 'tool-call'))
  })

  it('grants only reported native edits and creates with a consistent workspace target', async (t) => {
    const outcomes: unknown[] = []
    const firstToolCallId = randomUUID()
    let idlePermission: (() => Promise<unknown>) | undefined
    const { runtime, workspace, outside } = nativeWriteFixture(t, async (ctx) => {
      for (const [i, { claimed, report }] of requests.entries()) {
        outcomes.push(await askToolPermission(ctx, claimed, report, i === 0 ? firstToolCallId : undefined))
      }
      idlePermission = () => askToolPermission(ctx, edit, null, firstToolCallId)
      finishFakeTurn(ctx)
    })
    const existing = join(workspace, 'existing.txt')
    const other = join(workspace, 'other.txt')
    const created = join(workspace, 'new.txt')
    const outsideFile = join(outside, 'existing.txt')
    const symlinkFile = join(workspace, 'linked.txt')
    const symlinkDir = join(workspace, 'linked-dir')
    writeFileSync(existing, 'original')
    writeFileSync(other, 'other')
    writeFileSync(outsideFile, 'outside')
    symlinkSync(outsideFile, symlinkFile, 'file')
    symlinkSync(outside, symlinkDir, 'dir')
    const edit = nativeFileCall('replace_file_content', existing)
    const requests: Array<{
      label: string
      claimed: Record<string, unknown>
      report?: Record<string, unknown> | null
      allowed?: true
    }> = [
      { label: 'native edit', claimed: edit, allowed: true },
      { label: 'native multi-replace', claimed: nativeFileCall('multi_replace_file_content', existing), allowed: true },
      {
        label: 'native create with an equivalent relative target and no locations in request',
        claimed: { name: 'write_to_file', kind: 'edit', rawInput: { Path: 'new.txt' } },
        report: nativeFileCall('write_to_file', created, 'Path'),
        allowed: true,
      },
      { label: 'native shell presented as edit', claimed: nativeFileCall('run_command', existing) },
      { label: 'non-edit kind in request', claimed: { ...edit, kind: 'execute' }, report: edit },
      { label: 'non-edit kind in report', claimed: edit, report: { ...edit, kind: 'execute' } },
      { label: 'different targets in report and request', claimed: edit, report: nativeFileCall(edit.name, other) },
      { label: 'different rawInput and location targets', claimed: { ...edit, locations: [{ path: other }] } },
      { label: 'tool call ID was never reported', claimed: edit, report: null },
      { label: 'title is not a structured identity', claimed: { ...edit, name: undefined, title: edit.name } },
      { label: 'target outside workspace', claimed: nativeFileCall(edit.name, outsideFile) },
      { label: 'symlink file escapes workspace', claimed: nativeFileCall(edit.name, symlinkFile) },
      { label: 'create through symlink directory escapes workspace', claimed: nativeFileCall('create_file', join(symlinkDir, 'new.txt'), 'Path') },
      { label: 'Pi MCP write permission also stays disabled', claimed: { ...edit, name: 'mcp_pi_write' } },
    ]

    const chunks = await collectChunks(runtime.stream({ ...nativeWriteRequest, messages: [nativeWriteInput] }))
    assert.ok(chunks.some((c) => c.type === 'finish' && c.reason.kind === 'stop'))
    for (const [i, { label, allowed }] of requests.entries()) {
      assert.deepEqual(outcomes[i], allowed ? allowOnce : rejectOnce, label)
    }
    assert.ok(idlePermission)
    assert.deepEqual(await idlePermission(), rejectOnce, 'native writes require a live turn')
  })

  it('does not grant native edit if only the source Pi write tool was offered', async (t) => {
    let edit: unknown
    let create: unknown
    const { runtime, workspace } = nativeWriteFixture(t, async (ctx) => {
      edit = await askToolPermission(ctx, nativeFileCall('edit_file', existing))
      create = await askToolPermission(ctx, nativeFileCall('create_file', join(workspace, 'new.txt'), 'Path'))
      finishFakeTurn(ctx)
    })
    const existing = join(workspace, 'existing.txt')
    writeFileSync(existing, 'original')
    await collectChunks(runtime.stream({
      ...nativeWriteRequest,
      tools: piFileTools.filter((tool) => tool.name !== 'edit'),
      messages: [nativeWriteInput],
    }))
    assert.deepEqual(edit, rejectOnce)
    assert.deepEqual(create, allowOnce)
  })

  it('keeps Pi edit/write advertised and denies native edits without opt-in', async (t) => {
    let listedTools: string[] = []
    let edit: unknown
    const { runtime, workspace } = nativeWriteFixture(t, async (ctx) => {
      if (ctx.mcpUrl !== undefined) {
        const list = await mcpPost(ctx.mcpUrl, ctx.mcpAuth, { id: 1, method: 'tools/list', params: {} })
        listedTools = (list.result as { tools?: Array<{ name: string }> })?.tools?.map((tool) => tool.name) ?? []
      }
      edit = await askToolPermission(ctx, nativeFileCall('edit_file', existing))
      finishFakeTurn(ctx)
    }, false)
    const existing = join(workspace, 'existing.txt')
    writeFileSync(existing, 'original')
    await collectChunks(runtime.stream({ ...nativeWriteRequest, messages: [nativeWriteInput] }))
    assert.ok(listedTools.includes('edit'))
    assert.ok(listedTools.includes('write'))
    assert.deepEqual(edit, rejectOnce)
  })
})

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
