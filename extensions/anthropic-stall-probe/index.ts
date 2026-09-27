import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { createProbe, type ProbeRecord, type RequestTag } from "./probe"

const STATUS_KEY = "anthropic-stall"
const TICK_MS = 2_000
const TAG_MAX_AGE_MS = 10_000
const PROBE_KEY = Symbol.for("pi-config.anthropic-stall-probe")

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function describe(record: ProbeRecord): string {
  const waited = Math.round(record.durationMs / 1000)
  const headers =
    record.status === undefined
      ? "no response headers yet"
      : `HTTP ${record.status} after ${Math.round((record.headersMs ?? 0) / 1000)}s`
  const overage = record.headers["anthropic-ratelimit-unified-overage-in-use"]
  const parts = [
    `${headers}`,
    `${record.pingsBeforeFirstEvent} pings`,
    `no message_start for ${waited}s`,
  ]
  if (overage) parts.push(`overage-in-use=${overage}`)
  if (record.headers["request-id"]) parts.push(record.headers["request-id"])
  return parts.join(" · ")
}

export default function anthropicStallProbe(pi: ExtensionAPI): void {
  const globals = globalThis as Record<
    symbol,
    { dispose: () => void } | undefined
  >
  globals[PROBE_KEY]?.dispose()

  const logPath =
    process.env.PI_STALL_PROBE_LOG ||
    join(homedir(), ".pi", "agent", "anthropic-stall-probe.jsonl")
  const hosts = (process.env.PI_STALL_PROBE_HOSTS || "api.anthropic.com")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean)
  const warnAfterMs = envNumber("PI_STALL_PROBE_WARN_MS", 30_000)
  const abortAfterHeadersMs = envNumber("PI_STALL_PROBE_ABORT_MS", 0)
  // Mirrors Claude Code's event-level watchdog (300s); pings do not count as events.
  const eventIdleMs = envNumber("PI_STALL_PROBE_EVENT_IDLE_MS", 300_000)

  let latestCtx: ExtensionContext | undefined
  const pendingTags: Array<RequestTag & { at: number }> = []

  const withUi = (fn: (ctx: ExtensionContext) => void) => {
    const ctx = latestCtx
    if (!ctx?.hasUI) return
    try {
      fn(ctx)
    } catch {
      // A replaced or shut-down session can make an old context stale.
    }
  }

  mkdirSync(dirname(logPath), { recursive: true })
  const probe = createProbe({
    hosts,
    warnAfterMs,
    abortAfterHeadersMs,
    eventIdleMs,
    write: (record) => appendFileSync(logPath, `${JSON.stringify(record)}\n`),
    takeTag: () => {
      const cutoff = Date.now() - TAG_MAX_AGE_MS
      while (pendingTags.length > 0 && pendingTags[0].at < cutoff)
        pendingTags.shift()
      return pendingTags.shift()
    },
    onStall: (record, first) => {
      withUi((ctx) => {
        ctx.ui.setStatus(STATUS_KEY, `⚠ anthropic stalled: ${describe(record)}`)
        if (first) {
          const hint =
            abortAfterHeadersMs > 0
              ? `auto-abort+retry after ${Math.round(abortAfterHeadersMs / 1000)}s without message_start`
              : "press Esc and retry, or set PI_STALL_PROBE_ABORT_MS to auto-retry"
          ctx.ui.notify(
            `Anthropic stream stalled (${describe(record)}). ${hint}. Log: ${logPath}`,
            "warning"
          )
        }
      })
    },
    onRecovered: () => withUi((ctx) => ctx.ui.setStatus(STATUS_KEY, undefined)),
  })
  const timer = setInterval(probe.tick, TICK_MS)
  timer.unref()

  const dispose = () => {
    clearInterval(timer)
    probe.dispose()
    withUi((ctx) => ctx.ui.setStatus(STATUS_KEY, undefined))
    if (globals[PROBE_KEY]?.dispose === dispose) globals[PROBE_KEY] = undefined
  }
  globals[PROBE_KEY] = { dispose }

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx
  })

  pi.on("before_provider_request", (event, ctx) => {
    latestCtx = ctx
    const payload = event.payload as
      | { model?: unknown; messages?: unknown; max_tokens?: unknown }
      | undefined
    // Only Anthropic Messages payloads; other providers' requests never reach the probed host.
    if (
      typeof payload?.model !== "string" ||
      !Array.isArray(payload.messages) ||
      payload.max_tokens === undefined
    )
      return
    let sessionFile: string | undefined
    try {
      sessionFile = ctx.sessionManager.getSessionFile()
    } catch {
      sessionFile = undefined
    }
    pendingTags.push({
      at: Date.now(),
      model: payload.model,
      sessionFile,
    })
    if (pendingTags.length > 20) pendingTags.shift()
  })

  pi.on("session_shutdown", dispose)
}
