import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProjectedSessionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type SummaryConfig } from "../src/config.js";
import {
  batchInput, collectSources, createSummary, digest, MAX_RECALL_CHARS, parseSummaries, planSummaries, readPins,
  recall, STATE_TYPE, stubFor, SUMMARY_TYPE, transformContext, type Source,
} from "../src/engine.js";

const config: SummaryConfig = { ...DEFAULT_CONFIG, keepRecentTurns: 1, minSourceChars: 20, minBatchChars: 20, maxInputChars: 5000, maxSourcesPerBatch: 2, maxBatchesPerRun: 1, minSavingsRatio: 0.2 };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const BIG = (c: string) => c.repeat(400);

let n = 0;
const base = (id: string) => ({ id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" });
function user(id = `u${++n}`): SessionEntry {
  return { type: "message", ...base(id), message: { role: "user", content: "go", timestamp: 1 } } as SessionEntry;
}
function assistant(id: string, callId: string, args: Record<string, unknown>, name = "read"): SessionEntry {
  return { type: "message", ...base(id), message: { role: "assistant", content: [{ type: "thinking", thinking: "plan", thinkingSignature: "sig" }, { type: "toolCall", id: callId, name, arguments: args }], api: "x", provider: "x", model: "x", usage, stopReason: "toolUse", timestamp: 1 } } as SessionEntry;
}
function result(id: string, callId: string, content: string | unknown[], name = "read", isError = false, extra: Record<string, unknown> = {}): SessionEntry {
  return { type: "message", ...base(id), message: { role: "toolResult", toolCallId: callId, toolName: name, content: typeof content === "string" ? [{ type: "text", text: content }] : content, isError, timestamp: 2, ...extra } } as SessionEntry;
}
function stored(id: string, summary: { content: string; details: unknown }): SessionEntry {
  return { type: "custom_message", ...base(id), customType: SUMMARY_TYPE, content: summary.content, display: true, details: summary.details } as SessionEntry;
}
type Edit = null | string | unknown[];
function project(entries: SessionEntry[], edits: Record<string, Edit> = {}): ProjectedSessionEntry[] {
  return entries.map(sourceEntry => {
    const edit = edits[sourceEntry.id];
    if (edit === null) return { sourceEntry, messages: [] };
    if (sourceEntry.type === "message") {
      const content = edit === undefined ? sourceEntry.message.content : typeof edit === "string" && sourceEntry.message.role !== "user" ? [{ type: "text", text: edit }] : edit;
      return { sourceEntry, messages: [{ ...sourceEntry.message, content } as AgentMessage] };
    }
    if (sourceEntry.type === "custom_message") {
      return { sourceEntry, messages: [{ role: "custom", customType: sourceEntry.customType, content: edit ?? sourceEntry.content, display: sourceEntry.display, details: sourceEntry.details, timestamp: 3 } as AgentMessage] };
    }
    return { sourceEntry, messages: [] };
  });
}
const messagesOf = (p: ProjectedSessionEntry[]) => p.flatMap(e => e.messages);

/** u1 a1/r1(read A) u2 a2/r2(read B) u3 */
function fixture() {
  const entries = [user("u1"), assistant("a1", "c1", { path: "a.txt" }), result("r1", "c1", BIG("A")), user("u2"), assistant("a2", "c2", { path: "b.txt" }), result("r2", "c2", BIG("B")), user("u3")];
  return { entries, projected: project(entries) };
}
function summarized(edits: Record<string, Edit> = {}, cfg = config) {
  const { entries, projected } = fixture();
  const source = collectSources(projected).find(s => s.entryId === "r1")!;
  const summary = createSummary(source, "file a is all As", "sid-1", cfg)!;
  const all = [...entries, stored("s1", summary)];
  const p = project(all, edits);
  return { all, p, source, summary, out: transformContext(messagesOf(p), p, all, cfg) };
}
const resultOf = (messages: AgentMessage[], id: string) => messages.find(m => m.role === "toolResult" && m.toolCallId === id) as (AgentMessage & { role: "toolResult" }) | undefined;
const summaries = (messages: AgentMessage[]) => messages.filter(m => m.role === "custom");

describe("collectSources", () => {
  test("pairs projected calls and results with stable typed fingerprints", () => {
    const [first] = collectSources(fixture().projected);
    expect(first?.ref).toBe("r_r1");
    expect(first?.turnIndex).toBe(1);
    expect(first?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(collectSources(fixture().projected)[0]?.fingerprint).toBe(first?.fingerprint);
  });
  test("fingerprint changes with arguments, content type, error state, and call identity", () => {
    const fp = (entries: SessionEntry[], edits: Record<string, Edit> = {}) => collectSources(project(entries, edits))[0]?.fingerprint;
    const original = fp([assistant("a", "c", { path: "x" }), result("r", "c", "hello")]);
    expect(fp([assistant("a", "c", { path: "y" }), result("r", "c", "hello")])).not.toBe(original);
    expect(fp([assistant("a", "c2", { path: "x" }), result("r", "c2", "hello")])).not.toBe(original);
    expect(fp([assistant("a", "c", { path: "x" }), result("r", "c", "hello", "read", true)])).not.toBe(original);
    expect(fp([assistant("a", "c", { path: "x" }), result("r", "c", [{ type: "text", text: "hel" }, { type: "text", text: "lo" }])])).not.toBe(original);
  });
  test("uses projected (natively edited) assistant arguments, not raw history", () => {
    const entries = [assistant("a", "c", { path: "secret.txt" }), result("r", "c", "hello")];
    const edited = project(entries, { a: [{ type: "toolCall", id: "c", name: "read", arguments: { path: "[redacted]" } }] });
    expect(collectSources(edited)[0]?.args).toEqual({ path: "[redacted]" });
  });
  test("omitted calls or results produce no source", () => {
    const entries = [assistant("a", "c", {}), result("r", "c", "hello")];
    expect(collectSources(project(entries, { a: null }))).toEqual([]);
    expect(collectSources(project(entries, { r: null }))).toEqual([]);
  });
  test("rejects duplicate call or result IDs and name mismatches", () => {
    expect(collectSources(project([assistant("a", "c", {}), assistant("b", "c", {}), result("r", "c", "x")]))).toEqual([]);
    expect(collectSources(project([assistant("a", "c", {}), result("r", "c", "x"), result("q", "c", "x")]))).toEqual([]);
    expect(collectSources(project([assistant("a", "c", {}, "read"), result("r", "c", "x", "bash")]))).toEqual([]);
  });
  test("a result before its call is not a completed pair", () => {
    expect(collectSources(project([user(), result("r", "c", BIG("x")), assistant("a", "c", {}), user()]))).toEqual([]);
  });
  test("counts genuine user messages only; tool results are not turns", () => {
    const entries = [user("u1"), assistant("a1", "c1", {}), result("r1", "c1", "x"), assistant("a2", "c2", {}), result("r2", "c2", "y"), user("u2")];
    expect(collectSources(project(entries)).map(s => s.turnIndex)).toEqual([1, 1]);
  });
});

describe("planSummaries", () => {
  test("plans older allowlisted sources and protects recent user turns", () => {
    const { entries, projected } = fixture();
    const plan = planSummaries(projected, entries, { ...config, keepRecentTurns: 2 });
    expect(plan.batches.flat().map(s => s.entryId)).toEqual(["r1"]);
    expect(plan.skipped.recent).toBe(1);
  });
  test("a latest user turn without tool calls still ages earlier work", () => {
    const { entries, projected } = fixture();
    expect(planSummaries(projected, entries, { ...config, keepRecentTurns: 1 }).batches.flat()).toHaveLength(2);
  });
  test("default keepRecentTurns is 2", () => {
    expect(DEFAULT_CONFIG.keepRecentTurns).toBe(2);
  });
  test("batch input contains full arguments and full text", () => {
    const { entries, projected } = fixture();
    const input = batchInput(planSummaries(projected, entries, config).batches[0]!);
    expect(input).toContain(BIG("A"));
    expect(JSON.parse(input).sources[0]).toEqual({ ref: "r_r1", toolName: "read", args: { path: "a.txt" }, text: BIG("A"), isError: false });
  });
  test("JSON escaping counts toward the actual input budget", () => {
    const text = "\"\n".repeat(100);
    const entries = [user(), assistant("a", "c", {}), result("r", "c", text), user()];
    const exact = batchInput(collectSources(project(entries))).length;
    expect(exact).toBeGreaterThan(text.length * 2);
    expect(planSummaries(project(entries), entries, { ...config, maxInputChars: exact }).batches).toHaveLength(1);
    const over = planSummaries(project(entries), entries, { ...config, maxInputChars: exact - 1 });
    expect(over.batches).toEqual([]);
    expect(over.skipped.oversized).toBe(1);
  });
  test("oversized sources are skipped, never truncated", () => {
    const entries = [user(), assistant("a", "c", {}), result("r", "c", "x".repeat(2000)), user()];
    const plan = planSummaries(project(entries), entries, { ...config, maxInputChars: 1000 });
    expect(plan.batches).toEqual([]);
    expect(plan.skipped.oversized).toBe(1);
  });
  test("respects sources-per-batch, batch count, and genuine minimum batch characters", () => {
    const entries: SessionEntry[] = [user()];
    for (let i = 0; i < 5; i++) entries.push(assistant(`a${i}`, `c${i}`, { path: `${i}` }), result(`r${i}`, `c${i}`, BIG(String(i))));
    entries.push(user());
    const plan = planSummaries(project(entries), entries, { ...config, maxSourcesPerBatch: 2, maxBatchesPerRun: 2 });
    expect(plan.batches.map(b => b.length)).toEqual([2, 2]);
    expect(plan.skipped.deferred).toBe(1);
    expect(plan.rawChars).toBe(1600);
    const tiny = planSummaries(project(entries), entries, { ...config, minBatchChars: 100000 });
    expect(tiny.batches).toEqual([]);
    expect(tiny.skipped.batchSmall).toBeGreaterThan(0);
  });
  test("skips secrets, errors, images, protected and non-allowlisted tools, and recall output", () => {
    const entries = [
      user(),
      assistant("a1", "c1", { path: "config/.env" }), result("r1", "c1", BIG("x")),
      assistant("a2", "c2", { command: "cat .env" }, "bash"), result("r2", "c2", BIG("y"), "bash"),
      assistant("a3", "c3", {}), result("r3", "c3", `${BIG("z")} api_key=abcdef123456`),
      assistant("a4", "c4", {}, "bash"), result("r4", "c4", BIG("e"), "bash", true),
      assistant("a5", "c5", {}), result("r5", "c5", [{ type: "image", data: "AAAA", mimeType: "image/png" }]),
      assistant("a6", "c6", {}, "context_recall"), result("r6", "c6", BIG("q"), "context_recall"),
      assistant("a7", "c7", {}, "custom_tool"), result("r7", "c7", BIG("t"), "custom_tool"),
      assistant("a8", "c8", {}, "ask_user"), result("r8", "c8", BIG("t"), "ask_user"),
      user(),
    ];
    const plan = planSummaries(project(entries), entries, { ...config, allowedTools: [...config.allowedTools, "ask_user"] });
    expect(plan.batches).toEqual([]);
    expect(plan.skipped).toEqual({ sensitive: 3, error: 1, nonText: 1, protected: 2, tool: 1 });
  });
  test("codemode needs complete, allowlisted, non-sensitive nested metadata", () => {
    const run = (nestedCalls: unknown) => {
      const entries = [user(), assistant("a", "c", { code: "x" }, "codemode"), result("r", "c", BIG("m"), "codemode", false, { nestedCalls }), user()];
      return planSummaries(project(entries), entries, config);
    };
    expect(run({ complete: true, calls: [{ id: "c/1", name: "read", arguments: { path: "a" }, status: "ok" }] }).batches).toHaveLength(1);
    expect(run(undefined).skipped.nested).toBe(1);
    expect(run({ complete: true, calls: [] }).batches).toHaveLength(1);
    expect(run({ complete: true, calls: [{ id: "c/1", name: "read", arguments: {} }] }).skipped.nested).toBe(1);
    expect(run({ complete: true, calls: [{ id: "c/1", name: "read", arguments: {}, status: "error" }] }).skipped.nested).toBe(1);
    expect(run({ complete: true, calls: [{ name: "read", arguments: {}, status: "ok" }] }).skipped.nested).toBe(1);
    expect(run({ complete: false, calls: [] }).skipped.nested).toBe(1);
    expect(run({ complete: true, calls: [{ id: "c/1", name: "write", arguments: {}, status: "ok" }] }).skipped.nested).toBe(1);
    expect(run({ complete: true, calls: [{ id: "c/1", name: "read", arguments: { path: "id_rsa" }, status: "ok" }] }).skipped.nested).toBe(1);
    expect(run({ complete: true, calls: [{ id: "c/1", name: "read", argumentsBytes: 99999, status: "ok" }] }).skipped.nested).toBe(1);
  });
  test("changed nested provenance invalidates authorization even when the text is identical", () => {
    const nestedCalls = { complete: true, calls: [{ id: "c/1", name: "read", arguments: { path: "safe.txt" }, status: "ok" }] };
    const entries = [user(), assistant("a", "c", { code: "x" }, "codemode"), result("r", "c", BIG("m"), "codemode", false, { nestedCalls }), user()];
    const projected = project(entries);
    const source = collectSources(projected)[0]!;
    const summary = createSummary(source, "Short summary", "nested-summary", config)!;
    const own = stored("s", summary);
    const all = project([...entries, own]);
    const changed = messagesOf(all).map(m => m.role === "toolResult" ? { ...m, nestedCalls: { ...nestedCalls, complete: false } } : m) as AgentMessage[];
    const transformed = transformContext(changed, all, [...entries, own], config);
    expect(transformed.some(m => m.role === "custom")).toBe(false);
    expect((transformed.find(m => m.role === "toolResult") as any).content[0].text).toBe(BIG("m"));
  });
  test("does not summarize when the outgoing request differs from the projection", () => {
    const { entries, projected } = fixture();
    const changeResult = messagesOf(projected).map(m => m.role === "toolResult" && m.toolCallId === "c1" ? { ...m, content: [{ type: "text", text: "changed" }] } : m);
    expect(planSummaries(projected, entries, config, changeResult as AgentMessage[]).skipped.transformed).toBe(1);
    const changeArgs = messagesOf(projected).map(m => m.role === "assistant" && JSON.stringify(m.content).includes("c1") ? { ...m, content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "z" } }] } : m);
    expect(planSummaries(projected, entries, config, changeArgs as AgentMessage[]).skipped.transformed).toBe(1);
    expect(planSummaries(projected, entries, config, messagesOf(projected)).batches.flat()).toHaveLength(2);
  });
  test("accepted versions are not re-summarized, even after the summary was omitted", () => {
    const { all } = summarized();
    expect(planSummaries(project(all, { s1: null }), all, config).skipped.accepted).toBe(1);
  });
  test("versions summarized by pending preview drafts (not yet on the branch) are accepted", () => {
    const { all, p } = summarized();
    const branchOnly = all.filter(e => e.id !== "s1");
    expect(planSummaries(p, branchOnly, config).skipped.accepted).toBe(1);
    expect(planSummaries(project(all, { s1: null }), branchOnly, config).skipped.accepted).toBe(1);
    expect(planSummaries(project(branchOnly), branchOnly, config).batches.flat().map(s => s.entryId)).toContain("r1");
  });
  test("natively edited summary still marks its source version accepted", () => {
    const { all } = summarized();
    expect(planSummaries(project(all, { s1: "edited" }), all, config).skipped.accepted).toBe(1);
  });
  test("a natively edited source is a new version and becomes eligible again", () => {
    const { all } = summarized();
    const plan = planSummaries(project(all, { r1: BIG("C") }), all, config);
    expect(plan.batches.flat().map(s => s.entryId)).toContain("r1");
  });
  test("restored sources are not summarized until resumed", () => {
    const { entries, projected } = fixture();
    const pin = (action: string, id: string) => ({ type: "custom", ...base(id), customType: STATE_TYPE, data: { action, ref: "r_r1" } }) as SessionEntry;
    expect(planSummaries(projected, [...entries, pin("restore", "p1")], config).skipped.restored).toBe(1);
    expect(planSummaries(projected, [...entries, pin("restore", "p1"), pin("resume", "p2")], config).skipped.restored).toBeUndefined();
  });
});

describe("pins", () => {
  test("latest valid action per ref wins and malformed state is ignored", () => {
    const e = (data: unknown, id: string) => ({ type: "custom", ...base(id), customType: STATE_TYPE, data }) as SessionEntry;
    expect([...readPins([e({ action: "restore", ref: "r_a" }, "1"), e({ action: "resume", ref: "r_a" }, "2"), e({ action: "restore", ref: "r_b" }, "3"), e({ action: "restore", ref: "../x" }, "4"), e({ action: "drop", ref: "r_c" }, "5")])]).toEqual(["r_b"]);
  });
});

describe("createSummary", () => {
  test("requires savings after counting body and stub, and stores no raw text", () => {
    const source = collectSources(fixture().projected)[0]!;
    const summary = createSummary(source, "short", "sid", config)!;
    expect(summary.details.contentHash).toBe(digest(summary.content));
    expect(JSON.stringify(summary.details)).not.toContain("AAAA");
    expect(summary.content).toContain("possibly lossy");
    const tiny: Source = { ...source, text: "x".repeat(200) };
    expect(createSummary(tiny, "short", "sid", config)).toBeUndefined();
    expect(createSummary(source, "   ", "sid", config)).toBeUndefined();
  });
});

describe("transformContext", () => {
  test("stubs only the matching result and preserves assistant, thinking, and metadata", () => {
    const { out, p } = summarized();
    const stub = resultOf(out, "c1")!;
    expect(stub.content).toEqual([{ type: "text", text: stubFor({ ref: "r_r1" }) }]);
    expect(stub.isError).toBe(false);
    expect(stub.toolName).toBe("read");
    expect(resultOf(out, "c2")?.content).toEqual(resultOf(messagesOf(p), "c2")?.content);
    expect(out.filter(m => m.role === "assistant")).toEqual(messagesOf(p).filter(m => m.role === "assistant"));
    expect(summaries(out)).toHaveLength(1);
    expect(out).toHaveLength(messagesOf(p).length);
  });
  test("request reordering a result before its call drops the summary and does not stub", () => {
    const { all, p } = summarized();
    const messages = messagesOf(p);
    const result = resultOf(messages, "c1")!;
    const reordered = [result, ...messages.filter(m => m !== result)];
    const out = transformContext(reordered, p, all, config);
    expect(summaries(out)).toHaveLength(0);
    expect(resultOf(out, "c1")?.content).toEqual([{ type: "text", text: BIG("A") }]);
  });
  test("does not mutate canonical projected messages", () => {
    const { p } = summarized();
    const before = JSON.stringify(p);
    transformContext(messagesOf(p), p, [], config);
    expect(JSON.stringify(p)).toBe(before);
  });
  test("source omission drops the stale summary and never resurrects the source", () => {
    const { out } = summarized({ r1: null });
    expect(summaries(out)).toHaveLength(0);
    expect(resultOf(out, "c1")).toBeUndefined();
  });
  test("source replacement drops the stale summary and keeps the current replacement", () => {
    const { out } = summarized({ r1: "[redacted]" });
    expect(summaries(out)).toHaveLength(0);
    expect(resultOf(out, "c1")?.content).toEqual([{ type: "text", text: "[redacted]" }]);
  });
  test("argument edits invalidate the summary", () => {
    const { out } = summarized({ a1: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "other" } }] });
    expect(summaries(out)).toHaveLength(0);
    expect(resultOf(out, "c1")?.content).toEqual([{ type: "text", text: BIG("A") }]);
  });
  test("natively edited summary is preserved but revokes stubbing", () => {
    const { out } = summarized({ s1: "user-corrected summary" });
    expect(summaries(out).map(m => (m as { content: unknown }).content)).toEqual(["user-corrected summary"]);
    expect(resultOf(out, "c1")?.content).toEqual([{ type: "text", text: BIG("A") }]);
  });
  test("omitted summary is not reinjected and the original stays visible", () => {
    const { out } = summarized({ s1: null });
    expect(summaries(out)).toHaveLength(0);
    expect(resultOf(out, "c1")?.content).toEqual([{ type: "text", text: BIG("A") }]);
  });
  test("an earlier handler hiding or changing the summary prevents stubbing", () => {
    const { p, all } = summarized();
    const hidden = messagesOf(p).filter(m => m.role !== "custom");
    expect(resultOf(transformContext(hidden, p, all, config), "c1")?.content).toEqual([{ type: "text", text: BIG("A") }]);
    const changed = messagesOf(p).map(m => m.role === "custom" ? { ...m, content: "changed" } : m) as AgentMessage[];
    const out = transformContext(changed, p, all, config);
    expect(resultOf(out, "c1")?.content).toEqual([{ type: "text", text: BIG("A") }]);
    expect(summaries(out)).toHaveLength(1);
  });
  test("an earlier handler changing the source in the request prevents stubbing", () => {
    const { p, all } = summarized();
    const changed = messagesOf(p).map(m => m.role === "toolResult" && m.toolCallId === "c1" ? { ...m, content: [{ type: "text", text: "other" }] } : m) as AgentMessage[];
    const out = transformContext(changed, p, all, config);
    expect(resultOf(out, "c1")?.content).toEqual([{ type: "text", text: "other" }]);
    expect(summaries(out)).toHaveLength(0);
  });
  test("an earlier handler removing the source result or call drops our summary body", () => {
    const { p, all } = summarized();
    const noResult = messagesOf(p).filter(m => !(m.role === "toolResult" && m.toolCallId === "c1"));
    const out1 = transformContext(noResult, p, all, config);
    expect(summaries(out1)).toHaveLength(0);
    expect(resultOf(out1, "c1")).toBeUndefined();
    const noCall = messagesOf(p).map(m => m.role === "assistant" && JSON.stringify(m.content).includes("\"c1\"") ? { ...m, content: [{ type: "text", text: "x" }] } : m) as AgentMessage[];
    const out2 = transformContext(noCall, p, all, config);
    expect(summaries(out2)).toHaveLength(0);
    expect(resultOf(out2, "c1")?.content).toEqual([{ type: "text", text: BIG("A") }]);
  });
  test("a natively edited summary body survives an earlier handler redacting the source", () => {
    const { p, all } = summarized({ s1: "user-authored note" });
    const changed = messagesOf(p).map(m => m.role === "toolResult" && m.toolCallId === "c1" ? { ...m, content: [{ type: "text", text: "[redacted]" }] } : m) as AgentMessage[];
    const out = transformContext(changed, p, all, config);
    expect(summaries(out).map(m => (m as { content: unknown }).content)).toEqual(["user-authored note"]);
    expect(resultOf(out, "c1")?.content).toEqual([{ type: "text", text: "[redacted]" }]);
  });
  test("off removes generated summaries and leaves originals; native edits remain", () => {
    const off = { ...config, enabled: false };
    const { out } = summarized({}, off);
    expect(summaries(out)).toHaveLength(0);
    expect(resultOf(out, "c1")?.content).toEqual([{ type: "text", text: BIG("A") }]);
    expect(summaries(summarized({ s1: "edited" }, off).out)).toHaveLength(1);
  });
  test("restore pin suppresses the summary; resume reapplies it", () => {
    const { p, all } = summarized();
    const pin = (action: string, id: string) => ({ type: "custom", ...base(id), customType: STATE_TYPE, data: { action, ref: "r_r1" } }) as SessionEntry;
    const restored = transformContext(messagesOf(p), p, [...all, pin("restore", "p1")], config);
    expect(summaries(restored)).toHaveLength(0);
    expect(resultOf(restored, "c1")?.content).toEqual([{ type: "text", text: BIG("A") }]);
    const resumed = transformContext(messagesOf(p), p, [...all, pin("restore", "p1"), pin("resume", "p2")], config);
    expect(resultOf(resumed, "c1")?.content).toEqual([{ type: "text", text: stubFor({ ref: "r_r1" }) }]);
  });
  test("latest valid summary per source wins and older duplicates are dropped", () => {
    const { entries, projected } = fixture();
    const source = collectSources(projected)[0]!;
    const all = [...entries, stored("s1", createSummary(source, "first", "sid-1", config)!), stored("s2", createSummary(source, "second", "sid-2", config)!)];
    const p = project(all);
    const out = transformContext(messagesOf(p), p, all, config);
    expect(summaries(out).map(m => JSON.stringify(m))).toEqual([expect.stringContaining("second")]);
    expect(resultOf(out, "c1")?.content).toEqual([{ type: "text", text: stubFor(source) }]);
  });
  test("forged or malformed summary metadata never authorizes stubbing", () => {
    const { entries, projected } = fixture();
    const source = collectSources(projected)[0]!;
    const forged = stored("s1", { content: "fake", details: { version: 1, summaryId: "x", source: { entryId: "r1", toolCallId: "c1", fingerprint: source.fingerprint }, contentHash: "bad" } });
    const all = [...entries, forged];
    const out = transformContext(messagesOf(project(all)), project(all), all, config);
    expect(resultOf(out, "c1")?.content).toEqual([{ type: "text", text: BIG("A") }]);
    expect(summaries(out)).toHaveLength(1);
  });
  test("summary for a source on another branch is stale here", () => {
    const { summary } = summarized();
    const branch = [user("u1"), assistant("a1", "c1", { path: "a.txt" }), result("rX", "c1", BIG("A")), stored("s1", summary)];
    const out = transformContext(messagesOf(project(branch)), project(branch), branch, config);
    expect(summaries(out)).toHaveLength(0);
    expect(resultOf(out, "c1")?.content).toEqual([{ type: "text", text: BIG("A") }]);
  });
});

describe("parseSummaries", () => {
  const sources = () => collectSources(fixture().projected);
  test("accepts exact coverage, optionally fenced", () => {
    const body = JSON.stringify({ summaries: [{ ref: "r_r1", summary: " a " }, { ref: "r_r2", summary: "b" }] });
    expect([...parseSummaries(body, sources())]).toEqual([["r_r1", "a"], ["r_r2", "b"]]);
    expect(parseSummaries("```json\n" + body + "\n```", sources()).size).toBe(2);
  });
  test("rejects missing, extra, duplicate, empty, unknown-field, and non-JSON responses", () => {
    const s = sources();
    const bad = [
      { summaries: [{ ref: "r_r1", summary: "a" }] },
      { summaries: [{ ref: "r_r1", summary: "a" }, { ref: "r_r1", summary: "b" }] },
      { summaries: [{ ref: "r_r1", summary: "a" }, { ref: "r_zz", summary: "b" }] },
      { summaries: [{ ref: "r_r1", summary: "a" }, { ref: "r_r2", summary: " " }] },
      { summaries: [{ ref: "r_r1", summary: "a" }, { ref: "r_r2", summary: "b", extra: 1 }] },
      { summaries: [{ ref: "r_r1", summary: "a" }, { ref: "r_r2", summary: 3 }] },
      { summaries: [], other: true },
    ];
    for (const value of bad) expect(() => parseSummaries(JSON.stringify(value), s)).toThrow();
    expect(() => parseSummaries("here you go", s)).toThrow();
  });
});

describe("recall", () => {
  test("returns current projected text, including native replacements", () => {
    const { entries } = fixture();
    expect(recall(project(entries, { r1: "replacement" }), "r_r1", 0, 100).text).toBe("replacement");
  });
  test("errors for omitted, compacted, foreign, malformed, or non-text refs", () => {
    const { entries } = fixture();
    expect(() => recall(project(entries, { r1: null }), "r_r1", 0, 10)).toThrow();
    expect(() => recall(project(entries.filter(e => e.id !== "r1")), "r_r1", 0, 10)).toThrow();
    expect(() => recall(project(entries), "r_u1", 0, 10)).toThrow();
    expect(() => recall(project(entries), "../r1", 0, 10)).toThrow();
    expect(() => recall(project(entries), "r_r1", -1, 10)).toThrow();
    expect(() => recall(project(entries), "r_r1", 0, MAX_RECALL_CHARS + 1)).toThrow();
    expect(() => recall(project([result("img", "c", [{ type: "image", data: "A", mimeType: "image/png" }])]), "r_img", 0, 10)).toThrow();
  });
  test("paginates without splitting code points and reassembles losslessly", () => {
    const text = `x${"🙂".repeat(5)}é${"界".repeat(3)}y`;
    const p = project([assistant("a", "c", {}), result("r", "c", text)]);
    for (const limit of [1, 2, 3, 7]) {
      let offset: number | null = 0;
      let joined = "";
      while (offset !== null) {
        const page = recall(p, "r_r", offset, limit);
        expect(page.text.length).toBeGreaterThan(0);
        expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(page.text)).toBe(false);
        joined += page.text;
        offset = page.nextOffset;
      }
      expect(joined).toBe(text);
    }
    expect(() => recall(p, "r_r", 2, 1)).toThrow();
  });
  test("respects the byte cap for multibyte text", () => {
    const text = "界".repeat(20000);
    const page = recall(project([assistant("a", "c", {}), result("r", "c", text)]), "r_r", 0, MAX_RECALL_CHARS);
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(32768);
    expect(page.nextOffset).toBe(page.text.length);
  });
});
