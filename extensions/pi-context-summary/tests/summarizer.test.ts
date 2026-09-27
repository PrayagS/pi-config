import { describe, expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateConfig } from "../src/config.js";
import type { Source } from "../src/engine.js";
import { ACCOUNTING_GRACE_MS, summarizeBatch, type ResponseUsage } from "../src/summarizer.js";

const model: Model<any> = { id: "m1", name: "Fake", provider: "fake", api: "test-api", reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4000 };
const source: Source = { entryId: "real", ref: "r_real", toolCallId: "call", toolName: "read", args: { path: "file.ts" }, text: "start\n" + "full body\n".repeat(200) + "TAIL_SENTINEL", isError: false, fingerprint: "a".repeat(64), turnIndex: 1 };
const config = validateConfig({ minSourceChars: 100, minBatchChars: 100, maxInputChars: 10000 });
function response(stopReason: AssistantMessage["stopReason"] = "stop", tokens = 30): AssistantMessage {
  return { role: "assistant", api: model.api, provider: "physical", model: "m1", responseModel: "actual", timestamp: Date.now(), stopReason,
    content: [{ type: "text", text: JSON.stringify({ summaries: [{ ref: source.ref, summary: "Important tail fact." }] }) }],
    usage: { input: tokens / 2, output: tokens / 2, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: tokens / 1000, output: tokens / 1000, cacheRead: 0, cacheWrite: 0, total: tokens / 500 } } };
}
function context(stream: ReturnType<typeof createAssistantMessageEventStream>, override: Partial<Model<any>> = {}, capture?: (value: any) => void): ExtensionContext {
  const selected = { ...model, ...override };
  return { model: selected, modelRegistry: { find: () => selected, streamSimple: (m: any, input: any, opts: any) => { capture?.({ model: m, input, opts }); return stream; } } } as unknown as ExtensionContext;
}
function complete(stream: ReturnType<typeof createAssistantMessageEventStream>, value = response()) {
  if (value.stopReason === "stop") stream.push({ type: "done", reason: "stop", message: value });
  else stream.push({ type: "error", reason: value.stopReason as "aborted" | "error", error: value });
  stream.end(value);
}

describe("summarizer accounting and bounds", () => {
  test("full input reaches the registry, with neutral signal/reasoning and physical final attribution once", async () => {
    const stream = createAssistantMessageEventStream();
    const controller = new AbortController();
    const usage: ResponseUsage[] = [];
    let sent: any;
    const pending = summarizeBatch(context(stream, {}, value => { sent = value; }), [source], config, controller.signal, value => usage.push(value));
    complete(stream);
    expect((await pending).get(source.ref)).toBe("Important tail fact.");
    expect(JSON.stringify(sent.input)).toContain("TAIL_SENTINEL");
    expect(JSON.stringify(sent.input)).toContain("UNTRUSTED DATA");
    expect(sent.input.tools ?? []).toEqual([]);
    expect(sent.opts.signal).toBe(controller.signal);
    expect(sent.opts.reasoning).toBe("low");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ provider: "physical", model: "actual", usage: { totalTokens: 30 } });
  });
  test("captures usage supplied only by the final aborted message", async () => {
    const stream = createAssistantMessageEventStream();
    const controller = new AbortController();
    const usage: ResponseUsage[] = [];
    const pending = summarizeBatch(context(stream), [source], config, controller.signal, value => usage.push(value));
    controller.abort();
    queueMicrotask(() => complete(stream, response("aborted", 40)));
    await expect(pending).rejects.toThrow();
    expect(usage).toHaveLength(1);
    expect(usage[0]!.usage.totalTokens).toBe(40);
    expect(usage[0]!.usage.cost.total).toBe(0.08);
  });
  test("keeps reported partial usage when result never resolves; late final is a no-op and snapshot cannot mutate", async () => {
    const stream = createAssistantMessageEventStream();
    const controller = new AbortController();
    const usage: ResponseUsage[] = [];
    const partial = response("stop", 20);
    const pending = summarizeBatch(context(stream), [source], config, controller.signal, value => usage.push(value));
    stream.push({ type: "start", partial });
    await Bun.sleep(5);
    const started = Date.now();
    controller.abort();
    await expect(pending).rejects.toThrow();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(ACCOUNTING_GRACE_MS - 20);
    expect(elapsed).toBeLessThan(ACCOUNTING_GRACE_MS + 350);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.usage.totalTokens).toBe(20);
    partial.usage.totalTokens = 999;
    partial.usage.cost.total = 999;
    complete(stream, response("aborted", 100));
    await Bun.sleep(5);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.usage.totalTokens).toBe(20);
    expect(usage[0]!.usage.cost.total).toBe(0.04);
  });
  test("a never-ending provider with no usage cannot hang cancellation or create invented usage", async () => {
    const stream = createAssistantMessageEventStream();
    const controller = new AbortController();
    const usage: ResponseUsage[] = [];
    const pending = summarizeBatch(context(stream), [source], config, controller.signal, value => usage.push(value));
    const started = Date.now();
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(ACCOUNTING_GRACE_MS + 350);
    expect(usage).toEqual([]);
    complete(stream, response("aborted"));
    await Bun.sleep(5);
    expect(usage).toEqual([]);
  });
  test("counts error usage exactly once and does not accept malformed or failed output", async () => {
    for (const value of [response("error"), { ...response(), content: [{ type: "text" as const, text: "malformed" }] }]) {
      const stream = createAssistantMessageEventStream();
      const usage: ResponseUsage[] = [];
      const pending = summarizeBatch(context(stream), [source], config, new AbortController().signal, item => usage.push(item));
      complete(stream, value);
      await expect(pending).rejects.toThrow();
      expect(usage).toHaveLength(1);
    }
  });
  test("refuses oversized source or declared physical context budget before calling any provider", async () => {
    for (const [sources, override] of [[[{ ...source, text: "x".repeat(11000) }], {}], [[source], { contextWindow: 2000 }]] as const) {
      let calls = 0;
      const stream = createAssistantMessageEventStream();
      await expect(summarizeBatch(context(stream, override, () => calls++), [...sources], config, new AbortController().signal, () => {})).rejects.toThrow();
      expect(calls).toBe(0);
    }
  });
  test("clamps output budget to the selected model's declared limit", async () => {
    const stream = createAssistantMessageEventStream();
    let sent: any;
    const pending = summarizeBatch(context(stream, { maxTokens: 500 }, value => { sent = value; }), [source], config, new AbortController().signal, () => {});
    complete(stream);
    await pending;
    expect(sent.opts.maxTokens).toBe(500);
  });
});
