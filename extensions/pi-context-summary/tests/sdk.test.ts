/**
 * Real Pi 1.0 SDK integration tests: ModelRuntime + SessionManager + DefaultResourceLoader +
 * createAgentSession with in-process fake providers. No network, credentials, or real providers.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession, AgentSessionRuntime, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI, type ExtensionFactory, type SessionEntry, withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { installContextSummary } from "../src/extension.js";
import { CALL_TYPE, STATE_TYPE, SUMMARY_TYPE } from "../src/engine.js";
import type { SummaryConfig } from "../src/config.js";

const realFetch = globalThis.fetch;
let networkAttempts = 0;
const roots: string[] = [];
beforeAll(() => {
  process.env.PI_OFFLINE = "1";
  process.env.PI_TELEMETRY = "0";
  globalThis.fetch = (async () => { networkAttempts++; throw new Error("network forbidden in tests"); }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fake provider
// ---------------------------------------------------------------------------
const SUMMARIZER_MARK = "Summarize historical tool results";
const SUMMARY_COST = 0.0125;
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

type Behavior = "ok" | "error" | "malformed" | "stall";
interface Fake {
  behavior: Behavior;
  mainContexts: any[];
  summaryRequests: { model: string; refs: string[]; input: string; maxTokens?: number }[];
  routeReasons: string[];
  /** Called when a stalled summary request starts; `release()` completes it successfully. */
  onStall?: (release: () => void) => void | Promise<void>;
}

function fakeStream(fake: Fake, provider: string) {
  return (model: Model<any>, context: any, options?: { signal?: AbortSignal; maxTokens?: number }) => {
    const stream = createAssistantMessageEventStream();
    const message = (text: string, stopReason: AssistantMessage["stopReason"], cost = 0): AssistantMessage => ({
      role: "assistant", content: [{ type: "text", text }], api: model.api, provider, model: model.id,
      usage: { ...zeroUsage(), input: 10, output: 5, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
      stopReason, timestamp: Date.now(), ...(stopReason === "error" || stopReason === "aborted" ? { errorMessage: "fake failure" } : {}),
    });
    let done = false;
    const finish = (m: AssistantMessage) => queueMicrotask(() => {
      if (done) return;
      done = true;
      if (m.stopReason === "error" || m.stopReason === "aborted") stream.push({ type: "error", reason: m.stopReason, error: m } as any);
      else stream.push({ type: "done", reason: "stop", message: m } as any);
      stream.end(m);
    });
    if (!JSON.stringify(context).includes(SUMMARIZER_MARK)) {
      fake.mainContexts.push(structuredClone(context));
      finish(message("main reply", "stop"));
      return stream;
    }
    const user = context.messages.find((m: any) => m.role === "user");
    const input = user.content.map((c: any) => c.text).join("");
    const refs: string[] = JSON.parse(input).sources.map((s: any) => s.ref);
    fake.summaryRequests.push({ model: `${provider}/${model.id}`, refs, input, maxTokens: options?.maxTokens });
    const ok = () => finish(message(JSON.stringify({ summaries: refs.map(ref => ({ ref, summary: `summary of ${ref}` })) }), "stop", SUMMARY_COST));
    if (fake.behavior === "stall") {
      const abort = () => finish(message("", "aborted", SUMMARY_COST));
      if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener("abort", abort, { once: true });
      void fake.onStall?.(ok);
    } else if (fake.behavior === "error") finish(message("", "error", SUMMARY_COST));
    else if (fake.behavior === "malformed") finish(message("not json at all", "stop", SUMMARY_COST));
    else ok();
    return stream;
  };
}
const MODEL = { id: "m1", name: "m1", reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4000 };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const ORIGINAL = (i: number) => `file ${i} contents: ` + "lorem ipsum dolor sit amet ".repeat(40);
/** Three genuine user turns; turns 1–2 each read one ~1000-char file (with thinking + toolCall). */
function seed(manager: SessionManager): string[] {
  const usage = zeroUsage();
  const resultIds: string[] = [];
  for (let turn = 1; turn <= 3; turn++) {
    manager.appendMessage({ role: "user", content: `turn ${turn}`, timestamp: Date.now() } as any);
    if (turn < 3) {
      manager.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: `plan ${turn}`, thinkingSignature: `sig-${turn}` }, { type: "toolCall", id: `call_${turn}`, name: "read", arguments: { path: `file${turn}.txt` } }], api: "fake-api", provider: "fake", model: "m1", usage, stopReason: "toolUse", timestamp: Date.now() } as any);
      resultIds.push(manager.appendMessage({ role: "toolResult", toolCallId: `call_${turn}`, toolName: "read", content: [{ type: "text", text: ORIGINAL(turn) }], isError: false, timestamp: Date.now() } as any));
    }
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: `answer ${turn}` }], api: "fake-api", provider: "fake", model: "m1", usage, stopReason: "stop", timestamp: Date.now() } as any);
  }
  return resultIds;
}

const BASE: Partial<SummaryConfig> = { minSourceChars: 100, minBatchChars: 100, keepRecentTurns: 2, maxSessionCalls: 20, cooldownMs: 1000, timeoutMs: 20000 };
interface Opts {
  config?: Partial<SummaryConfig>;
  entrypoint?: boolean;
  virtual?: boolean;
  persistent?: { sessionDir: string; file?: string };
  dir?: string;
  before?: ExtensionFactory[];
  noSeed?: boolean;
  manager?: SessionManager;
  /** Entrypoint only: raw configuration file bytes. */
  rawConfig?: string;
  /** Factory only: override the configuration path. */
  configPath?: string;
}
interface Harness { session: AgentSession; manager: SessionManager; fake: Fake; errors: unknown[]; resultIds: string[]; dir: string }
const open: AgentSession[] = [];
afterEach(() => { for (const s of open.splice(0)) s.dispose(); });

async function harness(opts: Opts = {}): Promise<Harness> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "pi-context-summary-sdk-"));
  if (!opts.dir) roots.push(dir);
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const fake: Fake = { behavior: "ok", mainContexts: [], summaryRequests: [], routeReasons: [] };
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  runtime.registerProvider("fake", { baseUrl: "http://127.0.0.1:9", apiKey: "test-only", api: "fake-api" as any, models: [MODEL as any], streamSimple: fakeStream(fake, "fake") as any });
  let model = runtime.getModel("fake", "m1")!;
  if (opts.virtual) {
    runtime.registerVirtualModel({ provider: "router", id: "auto", name: "Auto", route: (request: any) => {
      fake.routeReasons.push(request.reason);
      return { model: runtime.getModel("fake", "m1")!, thinkingLevel: "off" };
    } } as any);
    model = runtime.getModel("router", "auto")!;
  }
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off", retry: { enabled: false } } as any);
  const configPath = opts.configPath ?? join(agentDir, "context-summary.json");
  if (opts.entrypoint) writeFileSync(configPath, opts.rawConfig ?? JSON.stringify({ ...BASE, ...opts.config }));
  const ours = (pi: ExtensionAPI) => installContextSummary(pi, { initialConfig: { ...BASE, ...opts.config }, configPath });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    ...(opts.entrypoint
      ? { additionalExtensionPaths: [join(import.meta.dir, "..", "index.ts")], extensionFactories: opts.before ?? [] }
      : { extensionFactories: [...(opts.before ?? []), ours] }),
  } as any);
  await loader.reload();
  const loadErrors = loader.getExtensions().errors;
  if (loadErrors.length) throw new Error(`extension load errors: ${JSON.stringify(loadErrors)}`);
  const manager = opts.manager ?? (opts.persistent
    ? opts.persistent.file ? SessionManager.open(opts.persistent.file, opts.persistent.sessionDir) : SessionManager.create(dir, opts.persistent.sessionDir)
    : SessionManager.inMemory(dir));
  const resultIds = opts.noSeed ? [] : seed(manager);
  const { session } = await createAgentSession({ cwd: dir, agentDir, model, thinkingLevel: "off", modelRuntime: runtime, resourceLoader: loader, settingsManager, sessionManager: manager, noTools: "builtin" });
  open.push(session);
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: "print", onError: (e: unknown) => errors.push(e) } as any);
  return { session, manager, fake, errors, resultIds, dir };
}

type Custom = Extract<SessionEntry, { type: "custom_message" }>;
const summariesOf = (m: SessionManager) => m.getBranch().filter(e => e.type === "custom_message" && e.customType === SUMMARY_TYPE) as Custom[];
const callsOf = (m: SessionManager) => m.getBranch().filter(e => e.type === "custom" && e.customType === CALL_TYPE);
const usageOf = (m: SessionManager) => m.getBranch().filter(e => e.type === "usage") as Extract<SessionEntry, { type: "usage" }>[];
const FALLBACK_USAGE = "context-summary/usage-v1";
const fallbackOf = (m: SessionManager) => m.getEntries().filter(e => e.type === "custom" && e.customType === FALLBACK_USAGE);
const runner = (h: Harness) => (h.session as any)._extensionRunner;
async function tool(h: Harness, name: string, params: unknown): Promise<any> {
  const def = runner(h).getToolDefinition(name);
  if (!def) throw new Error(`tool ${name} not registered`);
  return def.execute("tc-test", params, undefined, undefined, runner(h).createContext());
}
async function command(h: Harness, args: string): Promise<void> {
  await runner(h).getCommand("context-summary").handler(args, runner(h).createCommandContext());
}
const lastMain = (h: Harness) => h.fake.mainContexts.at(-1);
const resultIn = (ctx: any, callId: string) => ctx.messages.find((m: any) => m.role === "toolResult" && m.toolCallId === callId);
const textIn = (msg: any) => msg?.content?.map((c: any) => c.text).join("");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
describe("Pi 1.0 SDK integration", () => {
  test("source entrypoint loads with file config and summarizes older results after settlement", async () => {
    const h = await harness({ entrypoint: true });
    await h.session.prompt("main task");
    expect(h.errors).toEqual([]);
    expect(h.fake.summaryRequests).toHaveLength(1);
    expect(h.fake.summaryRequests[0]!.refs).toEqual(h.resultIds.map(id => `r_${id}`));
    expect(summariesOf(h.manager)).toHaveLength(2);
  });

  test("final reply is persisted before summaries; durable IDs are real, canonical history unchanged", async () => {
    const h = await harness();
    const before = h.resultIds.map(id => structuredClone(h.manager.getEntry(id)));
    await h.session.prompt("main task");
    const branch = h.manager.getBranch();
    const finalReply = branch.findIndex(e => e.type === "message" && e.message.role === "assistant" && JSON.stringify(e.message.content).includes("main reply"));
    const firstSummary = branch.findIndex(e => e.type === "custom_message" && e.customType === SUMMARY_TYPE);
    expect(finalReply).toBeGreaterThan(-1);
    expect(firstSummary).toBeGreaterThan(finalReply);
    const summaries = summariesOf(h.manager);
    const ids = new Set(h.manager.getEntries().map(e => e.id));
    for (const s of summaries) {
      const d = s.details as any;
      expect(d.summaryId).toMatch(UUID);
      expect(d.summaryId).not.toBe(s.id);
      expect(h.resultIds).toContain(d.source.entryId);
      expect(ids.has(d.source.entryId)).toBe(true);
      expect(JSON.stringify(d)).not.toContain("lorem ipsum");
    }
    expect(h.resultIds.map(id => h.manager.getEntry(id))).toEqual(before);
    expect(h.fake.mainContexts).toHaveLength(1);
  });

  test("next request stubs summarized results, keeps pairs and thinking, no repair placeholders, no re-summarization", async () => {
    const h = await harness();
    await h.session.prompt("main task");
    await h.session.prompt("follow up");
    const ctx = lastMain(h);
    for (const [i, id] of h.resultIds.entries()) {
      const result = resultIn(ctx, `call_${i + 1}`);
      expect(textIn(result)).toContain(`r_${id}`);
      expect(textIn(result)).toContain("context_recall");
      expect(result.isError).toBe(false);
      const call = ctx.messages.find((m: any) => m.role === "assistant" && m.content.some((b: any) => b.type === "toolCall" && b.id === `call_${i + 1}`));
      expect(call.content[0]).toMatchObject({ type: "thinking", thinking: `plan ${i + 1}`, thinkingSignature: `sig-${i + 1}` });
    }
    const json = JSON.stringify(ctx);
    expect(json).not.toContain("No result provided");
    expect(json).toContain("summary of r_");
    expect(json).not.toContain(ORIGINAL(1));
    expect(h.fake.summaryRequests).toHaveLength(1);
    expect(h.fake.mainContexts).toHaveLength(2);
  });

  test("reopened persistent session reconstructs summaries from canonical history without new calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-context-summary-sdk-"));
    roots.push(dir);
    const sessionDir = join(dir, "sessions");
    const first = await harness({ dir, persistent: { sessionDir } });
    await first.session.prompt("main task");
    const file = first.manager.getSessionFile()!;
    expect(summariesOf(first.manager)).toHaveLength(2);
    first.session.dispose();
    const second = await harness({ dir, persistent: { sessionDir, file }, noSeed: true });
    expect(summariesOf(second.manager)).toHaveLength(2);
    await second.session.prompt("after reload");
    expect(textIn(resultIn(lastMain(second), "call_1"))).toContain("context_recall");
    expect(second.fake.summaryRequests).toHaveLength(0);
  });

  test("native edits: source redaction drops the stale summary; summary omission restores the original without re-summarizing", async () => {
    const h = await harness();
    await h.session.prompt("main task");
    const [r1] = h.resultIds;
    const s2 = summariesOf(h.manager).find(s => (s.details as any).source.entryId === h.resultIds[1])!;
    h.manager.appendContextEdit(r1!, { content: [{ type: "text", text: "[redacted]" }] } as any);
    h.manager.appendContextEdit(s2.id, null);
    await h.session.prompt("follow up");
    const ctx = lastMain(h);
    expect(textIn(resultIn(ctx, "call_1"))).toBe("[redacted]");
    expect(textIn(resultIn(ctx, "call_2"))).toBe(ORIGINAL(2));
    expect(JSON.stringify(ctx)).not.toContain("summary of r_");
    // r1 is a new (redacted, small) version; r2's accepted version is not re-summarized.
    expect(h.fake.summaryRequests).toHaveLength(1);
  });

  test("context_recall returns current projected text and refuses omitted or compacted sources", async () => {
    const h = await harness();
    await h.session.prompt("main task");
    const [r1, r2] = h.resultIds;
    const page = await tool(h, "context_recall", { ref: `r_${r1}`, limit: 50 });
    expect(page.structuredContent.text).toBe(ORIGINAL(1).slice(0, 50));
    expect(page.structuredContent.nextOffset).toBe(50);
    h.manager.appendContextEdit(r1!, null);
    await expect(tool(h, "context_recall", { ref: `r_${r1}` })).rejects.toThrow();
    const keep = h.manager.getBranch().filter(e => e.type === "message" && e.message.role === "user").at(-1)!;
    h.manager.appendCompaction("compacted", keep.id, 1000);
    await expect(tool(h, "context_recall", { ref: `r_${r2}` })).rejects.toThrow();
    await expect(tool(h, "context_recall", { ref: "r_doesnotexist" })).rejects.toThrow();
  });

  test("navigating to an earlier branch point leaves summaries behind", async () => {
    const h = await harness();
    const seededLeaf = h.manager.getLeafId()!;
    await h.session.prompt("main task");
    expect(summariesOf(h.manager)).toHaveLength(2);
    h.manager.branch(seededLeaf);
    expect(summariesOf(h.manager)).toHaveLength(0);
    h.fake.behavior = "error";
    await h.session.prompt("other branch");
    expect(textIn(resultIn(lastMain(h), "call_1"))).toBe(ORIGINAL(1));
  });

  test("context_summary preview/status tool is read-only and makes no provider calls", async () => {
    const h = await harness();
    const leaf = h.manager.getLeafId();
    const count = h.manager.getEntries().length;
    const preview = await tool(h, "context_summary", { action: "preview" });
    const status = await tool(h, "context_summary", { action: "status" });
    expect(preview.structuredContent.data.candidates.map((c: any) => c.ref)).toEqual([`r_${h.resultIds[0]}`]);
    expect(status.structuredContent.data.summaryAttempts).toBe(0);
    expect(h.manager.getLeafId()).toBe(leaf);
    expect(h.manager.getEntries()).toHaveLength(count);
    expect(h.fake.summaryRequests).toHaveLength(0);
    expect(h.fake.mainContexts).toHaveLength(0);
  });

  test("manual mode: settlement does nothing; /context-summary now summarizes without a main request", async () => {
    const h = await harness({ config: { mode: "manual" } });
    await h.session.prompt("main task");
    expect(h.fake.summaryRequests).toHaveLength(0);
    await h.session.prompt("/context-summary now");
    expect(h.fake.mainContexts).toHaveLength(1);
    expect(h.fake.summaryRequests).toHaveLength(1);
    expect(summariesOf(h.manager)).toHaveLength(2);
    expect(h.errors).toEqual([]);
  });

  test("virtual default model routes summarizer as a direct request; usage attributed to physical model", async () => {
    const h = await harness({ virtual: true });
    await h.session.prompt("main task");
    expect(h.fake.summaryRequests).toEqual([expect.objectContaining({ model: "fake/m1" })]);
    expect(h.fake.routeReasons).toContain("direct");
    // Virtual descriptors have maxTokens=0: never forward that sentinel as a real limit.
    expect(h.fake.summaryRequests[0]!.maxTokens).toBe(2000);
    const usage = usageOf(h.manager);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ kind: "context-summary", provider: "fake", model: "m1" });
    expect(h.session.getSessionStats().cost).toBeGreaterThanOrEqual(SUMMARY_COST);
    expect(summariesOf(h.manager)).toHaveLength(2);
  });

  for (const behavior of ["error", "malformed"] as const) {
    test(`provider ${behavior} leaves originals, writes no summary, still counts the attempt and usage`, async () => {
      const h = await harness();
      h.fake.behavior = behavior;
      await h.session.prompt("main task");
      expect(summariesOf(h.manager)).toHaveLength(0);
      expect(callsOf(h.manager)).toHaveLength(1);
      expect(usageOf(h.manager)).toHaveLength(1);
      await h.session.prompt("follow up");
      expect(textIn(resultIn(lastMain(h), "call_1"))).toBe(ORIGINAL(1));
      expect(h.errors).toEqual([]);
    });
  }

  test("session call cap includes failed attempts", async () => {
    const h = await harness({ config: { maxSessionCalls: 1, cooldownMs: 1000 } });
    h.fake.behavior = "error";
    await h.session.prompt("main task");
    expect(h.fake.summaryRequests).toHaveLength(1);
    await Bun.sleep(1100);
    h.fake.behavior = "ok";
    await h.session.prompt("follow up");
    expect(h.fake.summaryRequests).toHaveLength(1);
    expect(summariesOf(h.manager)).toHaveLength(0);
  });

  test("cancel command aborts a stalled summarizer (ctx.signal is unavailable at settlement); usage is still counted", async () => {
    const h = await harness();
    h.fake.behavior = "stall";
    h.fake.onStall = async () => { await Bun.sleep(10); await command(h, "cancel"); };
    await h.session.prompt("main task");
    expect(h.fake.summaryRequests).toHaveLength(1);
    expect(summariesOf(h.manager)).toHaveLength(0);
    const usage = usageOf(h.manager);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.usage.cost.total).toBe(SUMMARY_COST);
    expect(usage[0]!.usage.totalTokens).toBe(15);
  });

  test("timeout cancels a never-finishing summarizer within timeout + accounting grace", async () => {
    const h = await harness({ config: { timeoutMs: 1000 } });
    h.fake.behavior = "stall";
    const started = Date.now();
    await h.session.prompt("main task");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(1000 + 250 + 500);
    expect(summariesOf(h.manager)).toHaveLength(0);
    expect(usageOf(h.manager)).toHaveLength(1);
    expect(usageOf(h.manager)[0]!.usage.cost.total).toBe(SUMMARY_COST);
  });

  test("native appendUsage that appends then throws is charged exactly once, with no fallback", async () => {
    const h = await harness();
    const original = h.manager.appendUsage.bind(h.manager);
    (h.manager as any).appendUsage = (...args: Parameters<typeof original>) => { original(...args); throw new Error("wrapper failure after append"); };
    await h.session.prompt("main task");
    expect(usageOf(h.manager)).toHaveLength(1);
    expect(fallbackOf(h.manager)).toHaveLength(0);
    expect(h.session.getSessionStats().cost).toBeCloseTo(SUMMARY_COST, 10);
    expect(summariesOf(h.manager)).toHaveLength(2);
  });

  test("without native appendUsage, usage is recorded once as extension metadata and summaries still commit", async () => {
    const h = await harness();
    (h.manager as any).appendUsage = undefined;
    await h.session.prompt("main task");
    expect(usageOf(h.manager)).toHaveLength(0);
    const fallback = fallbackOf(h.manager);
    expect(fallback).toHaveLength(1);
    expect((fallback[0] as any).data).toMatchObject({ provider: "fake", model: "m1", usage: { totalTokens: 15 } });
    expect(h.session.getSessionStats().cost).toBe(0);
    expect(summariesOf(h.manager)).toHaveLength(2);
  });

  test("invalid configuration file disables summarization and commands never overwrite it", async () => {
    const raw = '{"enabled": true, "bogusSetting": 1}';
    const h = await harness({ entrypoint: true, rawConfig: raw });
    const file = join(h.dir, "agent", "context-summary.json");
    expect((await tool(h, "context_summary", { action: "status" })).structuredContent.data).toMatchObject({ enabled: false, invalidConfiguration: true });
    await command(h, "on");
    await command(h, "mode manual");
    expect(readFileSync(file, "utf8")).toBe(raw);
    await h.session.prompt("main task");
    expect(h.fake.summaryRequests).toHaveLength(0);
    expect(h.errors).toEqual([]);
  });

  test("pending configuration save blocks new jobs; a failed save keeps the old configuration and re-enables jobs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-context-summary-sdk-"));
    roots.push(dir);
    const configPath = join(dir, "config-is-a-directory");
    mkdirSync(configPath);
    const h = await harness({ dir, configPath });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = withFileMutationQueue(configPath, () => gate);
    const saving = command(h, "off");
    await Bun.sleep(10);
    await h.session.prompt("main task");
    expect(h.fake.summaryRequests).toHaveLength(0);
    release();
    await held;
    await saving;
    const status = await tool(h, "context_summary", { action: "status" });
    expect(status.structuredContent.data).toMatchObject({ enabled: true, savingConfiguration: false });
    await h.session.prompt("follow up");
    expect(h.fake.summaryRequests).toHaveLength(1);
    expect(summariesOf(h.manager).length).toBeGreaterThan(0);
  });

  test("an earlier ordinary context handler's redaction prevents auto-summarizing that source", async () => {
    const redactor = (pi: ExtensionAPI) => {
      pi.on("context", event => ({ messages: event.messages.map((m: any) => m.role === "toolResult" && m.toolCallId === "call_1" ? { ...m, content: [{ type: "text", text: "[hidden by policy]" }] } : m) }));
    };
    const h = await harness({ before: [redactor] });
    await h.session.prompt("main task");
    expect(h.fake.summaryRequests).toHaveLength(1);
    expect(h.fake.summaryRequests[0]!.refs).toEqual([`r_${h.resultIds[1]}`]);
    expect(h.fake.summaryRequests[0]!.input).not.toContain(ORIGINAL(1));
    expect(summariesOf(h.manager).map(s => (s.details as any).source.entryId)).toEqual([h.resultIds[1]]);
  });

  test("an earlier boundary context_edit draft excludes its pending source; other summaries and the edit commit", async () => {
    let target = "";
    const editor = (pi: ExtensionAPI) => {
      pi.on("agent_before_settle", event => ({ entries: [...event.entries, { type: "context_edit", targetId: target, replacement: { content: [{ type: "text", text: "[edited at boundary]" }] } }] }) as any);
    };
    const h = await harness({ before: [editor] });
    target = h.resultIds[0]!;
    await h.session.prompt("main task");
    const branch = h.manager.getBranch();
    expect(branch.some(e => e.type === "context_edit" && e.targetId === target)).toBe(true);
    const summaries = summariesOf(h.manager);
    expect(summaries.map(s => (s.details as any).source.entryId)).toEqual([h.resultIds[1]]);
    const ids = new Set(h.manager.getEntries().map(e => e.id));
    for (const s of summaries) expect(ids.has((s.details as any).source.entryId)).toBe(true);
    expect(h.fake.mainContexts).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });

  test("tree navigation waits for cancellation; old usage stays on the old branch and nothing commits", async () => {
    const h = await harness({ config: { mode: "manual" } });
    const target = h.manager.getBranch().find(e => e.type === "message" && e.message.role === "user")!.id;
    const before = h.manager.getLeafId()!;
    h.fake.behavior = "stall";
    let navigated: Promise<unknown> | undefined;
    h.fake.onStall = async () => { await Bun.sleep(10); navigated = h.session.navigateTree(target, { summarize: false }); };
    await command(h, "now");
    await navigated;
    expect(h.manager.getLeafId()).not.toBe(before);
    expect(h.manager.getEntries().filter(e => e.type === "custom_message" && e.customType === SUMMARY_TYPE)).toHaveLength(0);
    const usage = h.manager.getEntries().filter(e => e.type === "usage");
    expect(usage).toHaveLength(1);
    expect(h.manager.getBranch(usage[0]!.id).some(e => e.id === before)).toBe(true);
    expect(h.manager.getBranch().some(e => e.id === usage[0]!.id)).toBe(false);
  });

  test("external append during summarization drops the commit; usage is still counted", async () => {
    const h = await harness();
    h.fake.behavior = "stall";
    h.fake.onStall = async release => { await Bun.sleep(10); h.manager.appendCustomEntry("foreign/state", { x: 1 }); release(); };
    await h.session.prompt("main task");
    expect(h.fake.summaryRequests).toHaveLength(1);
    expect(summariesOf(h.manager)).toHaveLength(0);
    expect(usageOf(h.manager)).toHaveLength(1);
  });

  test("composes with earlier boundary drafts and never requests a continuation", async () => {
    const foreign = (pi: ExtensionAPI) => {
      pi.on("agent_before_settle", event => ({ entries: [...event.entries, { type: "custom", customType: "foreign/draft", data: { ok: true } }] }) as any);
    };
    const h = await harness({ before: [foreign] });
    await h.session.prompt("main task");
    const branch = h.manager.getBranch();
    expect(branch.some(e => e.type === "custom" && e.customType === "foreign/draft")).toBe(true);
    expect(summariesOf(h.manager)).toHaveLength(2);
    expect(h.fake.mainContexts).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });

  test("restore pin shows the original; resume reapplies the summary", async () => {
    const h = await harness();
    await h.session.prompt("main task");
    const ref = `r_${h.resultIds[0]}`;
    await command(h, `restore ${ref}`);
    expect(h.manager.getBranch().some(e => e.type === "custom" && e.customType === STATE_TYPE)).toBe(true);
    await h.session.prompt("follow up");
    expect(textIn(resultIn(lastMain(h), "call_1"))).toBe(ORIGINAL(1));
    await command(h, `resume ${ref}`);
    await h.session.prompt("again");
    expect(textIn(resultIn(lastMain(h), "call_1"))).toContain("context_recall");
  });

  test("real runtime session replacement waits for cancellation and never charges the new session", async () => {
    const h = await harness({ config: { mode: "manual" } });
    const oldId = h.manager.getSessionId();
    // Lifecycle services used here are cwd/agentDir; all sessions and the runtime
    // replacement protocol itself are real SDK objects, not simulated events.
    const services = { cwd: h.dir, agentDir: join(h.dir, "agent") } as any;
    const lifecycle = new AgentSessionRuntime(h.session, services, async options => {
      const next = await harness({ dir: options.cwd, manager: options.sessionManager, noSeed: true, config: { mode: "manual" } });
      return { session: next.session, services, diagnostics: [], extensionsResult: next.session.resourceLoader.getExtensions() };
    });
    h.fake.behavior = "stall";
    let switched: Promise<unknown> | undefined;
    h.fake.onStall = async () => { await Bun.sleep(10); switched = lifecycle.newSession(); };
    await command(h, "now");
    await switched;
    expect(lifecycle.session.sessionManager.getSessionId()).not.toBe(oldId);
    expect(usageOf(h.manager)).toHaveLength(1);
    expect(usageOf(h.manager)[0]!.usage.cost.total).toBe(SUMMARY_COST);
    expect(usageOf(lifecycle.session.sessionManager)).toHaveLength(0);
    expect(summariesOf(h.manager)).toHaveLength(0);
    expect(summariesOf(lifecycle.session.sessionManager)).toHaveLength(0);
    await lifecycle.dispose();
  });

  test("real runtime shutdown waits for cancellation and records usage once without committing summaries", async () => {
    const h = await harness({ config: { mode: "manual" } });
    const lifecycle = new AgentSessionRuntime(h.session, { cwd: h.dir, agentDir: join(h.dir, "agent") } as any, async () => { throw new Error("shutdown never creates a replacement"); });
    h.fake.behavior = "stall";
    let shutdown: Promise<void> | undefined;
    h.fake.onStall = async () => { await Bun.sleep(10); shutdown = lifecycle.dispose(); };
    await command(h, "now");
    await shutdown;
    expect(usageOf(h.manager)).toHaveLength(1);
    expect(usageOf(h.manager)[0]!.usage.cost.total).toBe(SUMMARY_COST);
    expect(summariesOf(h.manager)).toHaveLength(0);
    expect(h.errors).toEqual([]);
  });

  test("made no network attempts", () => {
    expect(networkAttempts).toBe(0);
  });
});
