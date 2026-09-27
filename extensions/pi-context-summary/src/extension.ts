import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionManager,
  type CustomMessageEntryDraft,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig, validateConfig, type SummaryConfig } from "./config.js";
import { CALL_TYPE, SUMMARY_TYPE, STATE_TYPE, collectSources, createSummary, planSummaries, recall, transformContext, type Plan, type Source, type Summary } from "./engine.js";
import { destination, summarizeBatch, type ResponseUsage } from "./summarizer.js";

const USAGE_KIND = "context-summary";
const FALLBACK_USAGE = "context-summary/usage-v1";
type Runner = typeof summarizeBatch;
interface Job {
  id: string;
  epoch: number;
  sessionId: string;
  leaf: string | null;
  ctx: ExtensionContext;
  controller: AbortController;
  summaryIds: Set<string>;
  trusted: boolean;
  done: Promise<void>;
}
export interface ExtensionOptions { configPath?: string; initialConfig?: Partial<SummaryConfig>; runner?: Runner }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** All mutations are extension-owned entries/configuration, never original history. */
export function installContextSummary(pi: ExtensionAPI, options: ExtensionOptions = {}): void {
  const file = options.configPath ?? join(getAgentDir(), "context-summary.json");
  const runBatch = options.runner ?? summarizeBatch;
  let config = validateConfig(options.initialConfig ?? {});
  let epoch = 0;
  let job: Job | undefined;
  let currentManager: ExtensionContext["sessionManager"] | undefined;
  let lastInput: { manager: ExtensionContext["sessionManager"]; messages: AgentMessage[] } | undefined;
  let cooldownUntil = 0;
  let lastFailure: string | undefined;
  let lastPhysical: string | undefined;
  let rejected = 0;
  let saving = false;
  let configInvalid = false;

  function cancel(): void { epoch++; job?.controller.abort(); }
  async function cancelAndWait(): Promise<void> {
    const pending = job?.done;
    cancel();
    // Native switching must not move our accounting into a different session.
    if (pending) await pending;
  }
  function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
    if (ctx.hasUI) ctx.ui.notify(text, level);
  }
  function callCount(ctx: ExtensionContext): number {
    return ctx.sessionManager.getEntries().filter(e => e.type === "custom" && e.customType === CALL_TYPE).length;
  }
  function branchStable(active: Job): boolean {
    const ctx = active.ctx;
    if (active.controller.signal.aborted || active.epoch !== epoch || currentManager !== ctx.sessionManager || ctx.sessionManager.getSessionId() !== active.sessionId || ctx.isProjectTrusted() !== active.trusted) return false;
    const branch = ctx.sessionManager.getBranch();
    const index = active.leaf === null ? -1 : branch.findIndex(e => e.id === active.leaf);
    if (active.leaf !== null && index < 0) return false;
    return branch.slice(index + 1).every(e =>
      e.type === "usage" ? e.kind === USAGE_KIND && e.note?.startsWith(`${active.id}:`) === true
      : e.type === "custom" ? (e.customType === CALL_TYPE || e.customType === FALLBACK_USAGE) && object(e.data) && e.data.jobId === active.id
      : e.type === "custom_message" && e.customType === SUMMARY_TYPE && object(e.details) && typeof e.details.summaryId === "string" && active.summaryIds.has(e.details.summaryId));
  }
  function sourcesStable(active: Job, sources: Source[]): boolean {
    if (!branchStable(active)) return false;
    const current = new Map(collectSources(active.ctx.sessionManager.buildSessionProjection().entries).map(s => [s.entryId, s.fingerprint]));
    return sources.every(s => current.get(s.entryId) === s.fingerprint);
  }
  function account(active: Job, attemptId: string, response: ResponseUsage): void {
    // Usage is session-wide, including cancelled requests on abandoned branches.
    // Never record a completed old request in a newly switched session.
    if (currentManager !== active.ctx.sessionManager || active.ctx.sessionManager.getSessionId() !== active.sessionId) return;
    const note = `${active.id}:${attemptId}`;
    lastPhysical = `${response.provider}/${response.model}`;
    // ReadonlySessionManager intentionally omits this public SessionManager method.
    // Isolate the checked Pi 1.0 capability bridge; never account via both paths.
    const manager = active.ctx.sessionManager as ExtensionContext["sessionManager"] & Partial<Pick<SessionManager, "appendUsage">>;
    if (typeof manager.appendUsage === "function") {
      try { manager.appendUsage(USAGE_KIND, response.provider, response.model, response.usage, note); return; }
      catch {
        // Some wrappers throw after a successful append. Never charge twice.
        if (manager.getEntries().some(e => e.type === "usage" && e.kind === USAGE_KIND && e.note === note)) return;
      }
    }
    if (currentManager === active.ctx.sessionManager) {
      pi.appendEntry(FALLBACK_USAGE, { version: 1, jobId: active.id, attemptId, ...response });
      notify(active.ctx, "Summary usage recorded separately: native usage accounting is unavailable.", "warning");
    }
  }
  function makePlan(ctx: ExtensionContext, entries = ctx.sessionManager.buildSessionProjection().entries): Plan {
    return planSummaries(entries, ctx.sessionManager.getBranch(), config, lastInput?.manager === ctx.sessionManager ? lastInput.messages : undefined);
  }
  function report(ctx: ExtensionContext, preview: boolean): { report: string; data: Record<string, JsonValue> } {
    const projection = ctx.sessionManager.buildSessionProjection();
    const plan = makePlan(ctx, projection.entries);
    const entries = ctx.sessionManager.getEntries();
    const usage = entries.filter(e => e.type === "usage" && e.kind === USAGE_KIND).reduce((n, e) => n + (e.type === "usage" ? e.usage.cost.total : 0), 0);
    const separate = entries.reduce((sum, e) => {
      if (e.type !== "custom" || e.customType !== FALLBACK_USAGE || !object(e.data) || !object(e.data.usage) || !object(e.data.usage.cost)) return sum;
      return sum + (typeof e.data.usage.cost.total === "number" ? e.data.usage.cost.total : 0);
    }, 0);
    const data = {
      enabled: config.enabled, mode: config.mode, selectedSummarizer: destination(ctx, config), lastPhysicalSummarizer: lastPhysical ?? null,
      summaryAttempts: callCount(ctx), maxSessionCalls: config.maxSessionCalls, reportedCatalogCost: usage + separate,
      nativeCatalogCost: usage, separateCatalogCost: separate, usageMayBeIncomplete: true, nativeUsageAccounting: typeof (ctx.sessionManager as unknown as Record<string, unknown>).appendUsage === "function",
      busy: !!job, savingConfiguration: saving, invalidConfiguration: configInvalid, cooldownMs: Math.max(0, cooldownUntil - Date.now()), lastFailure: lastFailure ?? null,
      rejectedSummaries: rejected, eligibleSources: plan.eligible.length, plannedBatches: plan.batches.length,
      candidateChars: plan.rawChars, skipped: plan.skipped,
      ...(preview ? { candidates: plan.batches.flat().map(s => ({ ref: s.ref, tool: s.toolName, chars: s.text.length })) } : {}),
    };
    return { report: JSON.stringify(data, null, 2), data };
  }
  async function generate(ctx: ExtensionContext, plan: Plan): Promise<{ active: Job; summaries: Summary[] } | undefined> {
    if (job || saving || !config.enabled || Date.now() < cooldownUntil || !plan.batches.length || callCount(ctx) >= config.maxSessionCalls) return;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const active: Job = { id: randomUUID(), epoch, sessionId: ctx.sessionManager.getSessionId(), leaf: ctx.sessionManager.getLeafId(), ctx, controller: new AbortController(), summaryIds: new Set(), trusted: ctx.isProjectTrusted(), done };
    job = active;
    const runConfig = { ...config };
    const timeout = setTimeout(() => active.controller.abort(), runConfig.timeoutMs);
    const parentCancel = () => active.controller.abort();
    const parentSignal = ctx.signal;
    parentSignal?.addEventListener("abort", parentCancel, { once: true });
    if (parentSignal?.aborted) active.controller.abort();
    const summaries: Summary[] = [];
    try {
      for (const sources of plan.batches.slice(0, runConfig.maxBatchesPerRun)) {
        if (!sourcesStable(active, sources) || callCount(ctx) >= runConfig.maxSessionCalls) break;
        const attemptId = randomUUID();
        pi.appendEntry(CALL_TYPE, { version: 1, jobId: active.id, attemptId, destination: destination(ctx, runConfig), sourceCount: sources.length, sourceChars: sources.reduce((n, s) => n + s.text.length, 0) });
        if (!sourcesStable(active, sources)) break;
        if (ctx.mode === "tui") ctx.ui.setStatus("context-summary", "Summarizing older context · Ctrl+Alt+S cancels");
        let finalized = false;
        let accounted = false;
        let text: Map<string, string>;
        try {
          text = await runBatch(ctx, sources, runConfig, active.controller.signal, response => {
            if (finalized || accounted) return;
            accounted = true;
            account(active, attemptId, response);
          });
        } finally { finalized = true; }
        if (!sourcesStable(active, sources)) break;
        for (const source of sources) {
          const id = randomUUID();
          const summary = createSummary(source, text.get(source.ref) ?? "", id, runConfig);
          if (summary) { active.summaryIds.add(id); summaries.push(summary); }
          else rejected++;
        }
      }
      if (!branchStable(active)) return;
      lastFailure = undefined;
      if (!summaries.length) cooldownUntil = Date.now() + runConfig.cooldownMs;
      return { active, summaries };
    } catch {
      lastFailure = active.controller.signal.aborted ? "cancelled or timed out" : "summarizer failed; originals preserved";
      cooldownUntil = Date.now() + runConfig.cooldownMs;
      notify(ctx, `Context summary: ${lastFailure}.`, "warning");
      // Preserve independently valid completed batches after a later provider failure.
      return !active.controller.signal.aborted && branchStable(active) ? { active, summaries } : undefined;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", parentCancel);
      if (job === active) job = undefined;
      finish();
      if (ctx.mode === "tui") ctx.ui.setStatus("context-summary", undefined);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    cancel(); currentManager = ctx.sessionManager; lastInput = undefined; cooldownUntil = 0; lastFailure = undefined; lastPhysical = undefined; rejected = 0;
    const loaded = options.initialConfig ? { config: validateConfig(options.initialConfig) } : await loadConfig(file);
    config = loaded.config;
    configInvalid = "warning" in loaded && !!loaded.warning;
    if ("warning" in loaded && loaded.warning) notify(ctx, String(loaded.warning), "warning");
  });
  pi.on("session_before_switch", cancelAndWait);
  pi.on("session_before_fork", cancelAndWait);
  pi.on("session_before_tree", cancelAndWait);
  pi.on("session_before_compact", cancelAndWait);
  pi.on("session_shutdown", cancelAndWait);
  pi.on("session_tree", (_event, ctx) => { cancel(); currentManager = ctx.sessionManager; lastInput = undefined; cooldownUntil = 0; });
  pi.on("input", () => { cancel(); });
  pi.on("before_agent_start", () => { cancel(); });
  pi.on("context", (event, ctx) => ({ messages: transformContext(event.messages, ctx.sessionManager.buildSessionProjection().entries, ctx.sessionManager.getBranch(), config) }));
  pi.on("context_with_system", (event, ctx) => {
    // Observe after all ordinary context handlers. This is a visibility guard,
    // not a durable archive or an attempt to override downstream extensions.
    lastInput = { manager: ctx.sessionManager, messages: event.messages };
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (config.mode !== "auto" || event.outcome !== "completed" || event.continue || event.context.pendingMessages.length) return;
    const plan = makePlan(ctx, event.context.contextEntries);
    // Boundary-only IDs are synthetic. Pending edits must not authorize a summary
    // of a version that is not yet committed to the real manager.
    const actual = new Map(collectSources(ctx.sessionManager.buildSessionProjection().entries).map(s => [s.entryId, s.fingerprint]));
    plan.batches = plan.batches.map(batch => batch.filter(s => actual.get(s.entryId) === s.fingerprint)).filter(batch => batch.reduce((n, s) => n + s.text.length, 0) >= config.minBatchChars);
    const result = await generate(ctx, plan);
    if (!result || !branchStable(result.active)) return;
    const current = new Map(collectSources(ctx.sessionManager.buildSessionProjection().entries).map(s => [s.entryId, s.fingerprint]));
    const drafts: CustomMessageEntryDraft[] = result.summaries.filter(s => current.get(s.details.source.entryId) === s.details.source.fingerprint).map(s => ({ type: "custom_message", customType: SUMMARY_TYPE, content: s.content, details: s.details, display: false }));
    if (drafts.length) return { entries: [...event.entries, ...drafts] };
  });

  pi.registerShortcut("ctrl+alt+s", { description: "Cancel context summarization", handler: async () => { cancel(); } });
  pi.registerTool({
    name: "context_recall", label: "Recall context", description: "Retrieve CURRENT projected historical tool output using the r_ reference in a lossy summary/stub. Never re-runs the original tool. Use nextOffset for further pages. Native omissions and compacted-away outputs are unavailable.",
    promptGuidelines: ["Summaries are lossy: use context_recall before relying on exact historical output."],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({ ref: Type.String(), offset: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])), limit: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 8192 }), Type.Null()])) }),
    outputSchema: Type.Object({ ref: Type.String(), toolName: Type.String(), text: Type.String(), offset: Type.Integer(), nextOffset: Type.Union([Type.Integer(), Type.Null()]), totalChars: Type.Integer(), isError: Type.Boolean() }),
    async execute(_id, params, _signal, _update, ctx) {
      const data = recall(ctx.sessionManager.buildSessionProjection().entries, params.ref, params.offset ?? 0, params.limit ?? 8192);
      return { content: [{ type: "text", text: `${data.toolName} ${data.ref} (chars ${data.offset}–${data.offset + data.text.length}/${data.totalChars}${data.nextOffset === null ? "; end" : `; nextOffset=${data.nextOffset}`})\n${data.text}` }], details: { ...data, text: undefined }, structuredContent: data };
    },
  });
  pi.registerTool({
    name: "context_summary", label: "Inspect context summaries", description: "Read-only context-summary status or dry-run preview. Reports destination, call budget, candidate refs and skips; never invokes a summarizer or changes context.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({ action: Type.Union([Type.Literal("status"), Type.Literal("preview")]) }),
    outputSchema: Type.Object({ report: Type.String(), data: Type.Unknown() }),
    async execute(_id, params, _signal, _update, ctx) { const data = report(ctx, params.action === "preview"); return { content: [{ type: "text", text: data.report }], details: undefined, structuredContent: data }; },
  });
  pi.registerCommand("context-summary", {
    description: "status | preview | now | cancel | on | off | mode auto/manual | model default/provider/id | restore ref | resume ref",
    handler: async (args, ctx) => {
      const [action = "status", value, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if (extra.length || (["status", "preview", "now", "cancel", "on", "off"].includes(action) && value !== undefined)) { notify(ctx, "Unexpected arguments.", "error"); return; }
      if (action === "cancel") { cancel(); notify(ctx, "Context summarization cancelled."); return; }
      if (action === "status" || action === "preview") { notify(ctx, report(ctx, action === "preview").report); return; }
      if (action === "now") {
        if (job) { notify(ctx, "Context summarization is already running.", "warning"); return; }
        await ctx.waitForIdle();
        currentManager = ctx.sessionManager;
        const result = await generate(ctx, makePlan(ctx));
        if (result) {
          for (const summary of result.summaries) {
            if (!ctx.isIdle() || !branchStable(result.active)) break;
            const current = collectSources(ctx.sessionManager.buildSessionProjection().entries).find(s => s.entryId === summary.details.source.entryId);
            if (current?.fingerprint !== summary.details.source.fingerprint) continue;
            // Synchronous guard+append; each record is independently valid.
            pi.sendMessage({ customType: SUMMARY_TYPE, content: summary.content, details: summary.details, display: false }, { triggerTurn: false });
          }
          notify(ctx, `Prepared ${result.summaries.length} context summaries.`);
        } else notify(ctx, "No eligible work (disabled, budget, cooldown, recent/protected outputs, or cancelled).");
        return;
      }
      if (action === "restore" || action === "resume") {
        if (!value) { notify(ctx, "Specify an r_ reference.", "error"); return; }
        cancel(); await ctx.waitForIdle();
        try { recall(ctx.sessionManager.buildSessionProjection().entries, value, 0, 1); }
        catch { notify(ctx, "Reference is not available in the current projection.", "error"); return; }
        pi.appendEntry(STATE_TYPE, { version: 1, action, ref: value });
        notify(ctx, action === "restore" ? "Original projected output restored and protected." : "Summary use resumed when a valid summary is visible.");
        return;
      }
      if (configInvalid) { notify(ctx, "Correct the configuration file and /reload before changing settings; the invalid file was not overwritten.", "error"); return; }
      if (saving) { notify(ctx, "Configuration is already being saved; retry after it finishes.", "warning"); return; }
      let next: SummaryConfig;
      try {
        if (action === "on" || action === "off") next = validateConfig({ ...config, enabled: action === "on" });
        else if (action === "mode" && value) next = validateConfig({ ...config, mode: value });
        else if (action === "model" && value) {
          if (value !== "default") { const slash = value.indexOf("/"); if (!ctx.modelRegistry.find(value.slice(0, slash), value.slice(slash + 1))) throw new Error("Model is not registered"); }
          next = validateConfig({ ...config, model: value });
        } else { notify(ctx, "Usage: /context-summary status|preview|now|cancel|on|off|mode auto/manual|model default/provider/id|restore ref|resume ref", "error"); return; }
      } catch { notify(ctx, "Invalid configuration or unregistered model.", "error"); return; }
      saving = true;
      cancel();
      try { await saveConfig(file, next); cancel(); config = next; cooldownUntil = 0; notify(ctx, `Context summary: ${action} ${value ?? ""}. Destination: ${destination(ctx, config)}. Selecting a model explicitly authorizes sending eligible outputs to its provider/router.`); }
      catch { notify(ctx, "Configuration was not saved; previous configuration retained.", "error"); }
      finally { saving = false; }
    },
  });
}
