import diagnosticsChannel from "node:diagnostics_channel"
import type { Transform } from "node:stream"
import zlib from "node:zlib"

// Observes Anthropic Messages requests at the undici layer. Pi's own events skip
// SSE `ping` frames, so they cannot tell "server is holding the stream open with
// pings" apart from "nothing is happening". Undici's diagnostics channels see raw
// response bytes for every request in this process without patching fetch.

export interface ProbeRecord {
  kind: "request" | "stall-warning" | "stall-abort" | "event-idle-abort"
  start: string
  secsPastHalfHour: number
  pid: number
  origin: string
  path: string
  model?: string
  sessionFile?: string
  reqBytes: number
  status?: number
  headersMs?: number
  firstEventMs?: number
  pingsBeforeFirstEvent: number
  pings: number
  events: number
  bytes: number
  maxGapMs?: number
  maxEventGapMs?: number
  durationMs: number
  outcome?: "complete" | "error" | "stall-abort" | "in-flight"
  error?: string
  headers: Record<string, string>
}

export interface RequestTag {
  model?: string
  sessionFile?: string
}

export interface ProbeOptions {
  hosts: string[]
  warnAfterMs: number
  abortAfterHeadersMs: number
  /** Abort once a started stream goes this long without a non-ping SSE event (0 disables). */
  eventIdleMs?: number
  now?: () => number
  write: (record: ProbeRecord) => void
  onStall?: (record: ProbeRecord, first: boolean) => void
  onRecovered?: (record: ProbeRecord) => void
  takeTag?: () => RequestTag | undefined
}

interface UndiciRequestLike {
  origin?: unknown
  path?: unknown
  method?: unknown
  aborted?: boolean
  abort?: ((err: Error) => void) | null
}

interface Tracked {
  request: UndiciRequestLike
  startedAt: number
  origin: string
  path: string
  tag?: RequestTag
  reqBytes: number
  status?: number
  headersAt?: number
  firstEventAt?: number
  lastEventAt?: number
  pingsBeforeFirstEvent: number
  pings: number
  events: number
  maxEventGapMs: number
  decoder?: Transform
  bytes: number
  lastChunkAt?: number
  maxGapMs: number
  lineBuffer: string
  headers: Record<string, string>
  warned: boolean
  stallAborted: boolean
}

const KEPT_HEADERS = new Set([
  "request-id",
  "cf-ray",
  "retry-after",
  "x-should-retry",
  "content-type",
  "content-encoding",
])
const MAX_LINE_BUFFER = 64 * 1024
const MAX_TRACK_MS = 60 * 60 * 1000

function keepHeader(name: string): boolean {
  return KEPT_HEADERS.has(name) || name.startsWith("anthropic-ratelimit-")
}

function toText(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8")
  return String(value)
}

export function parseRawHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!Array.isArray(raw)) return out
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = toText(raw[i]).toLowerCase()
    if (keepHeader(name)) out[name] = toText(raw[i + 1])
  }
  return out
}

function createDecoder(encoding: string | undefined): Transform | undefined {
  const flush = {
    flush: zlib.constants.Z_SYNC_FLUSH,
    finishFlush: zlib.constants.Z_SYNC_FLUSH,
  }
  switch (encoding?.trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip(flush)
    case "deflate":
      return zlib.createInflate(flush)
    case "br":
      return zlib.createBrotliDecompress()
    default:
      return undefined
  }
}

function originHost(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

function isMessagesPath(path: string): boolean {
  return /^\/v1\/messages(?:\?|$)/.test(path)
}

export function createProbe(options: ProbeOptions): {
  dispose: () => void
  tick: () => void
  inFlight: () => number
} {
  const now = options.now ?? Date.now
  const tracked = new WeakMap<object, Tracked>()
  const live = new Set<Tracked>()

  const snapshot = (
    t: Tracked,
    kind: ProbeRecord["kind"],
    outcome: ProbeRecord["outcome"],
    error?: string
  ): ProbeRecord => {
    const at = now()
    return {
      kind,
      start: new Date(t.startedAt).toISOString(),
      secsPastHalfHour: Math.floor((t.startedAt / 1000) % 1800),
      pid: process.pid,
      origin: t.origin,
      path: t.path,
      model: t.tag?.model,
      sessionFile: t.tag?.sessionFile,
      reqBytes: t.reqBytes,
      status: t.status,
      headersMs:
        t.headersAt === undefined ? undefined : t.headersAt - t.startedAt,
      firstEventMs:
        t.firstEventAt === undefined ? undefined : t.firstEventAt - t.startedAt,
      pingsBeforeFirstEvent: t.pingsBeforeFirstEvent,
      pings: t.pings,
      events: t.events,
      bytes: t.bytes,
      maxGapMs: t.maxGapMs || undefined,
      maxEventGapMs: t.maxEventGapMs || undefined,
      durationMs: at - t.startedAt,
      outcome,
      error,
      headers: t.headers,
    }
  }

  const safeWrite = (record: ProbeRecord) => {
    try {
      options.write(record)
    } catch {
      // Diagnostics must never break the request path.
    }
  }

  const finish = (
    t: Tracked,
    outcome: "complete" | "error" | "stall-abort",
    error?: string
  ) => {
    if (!live.delete(t)) return
    const endedAt = now()
    let written = false
    const write = () => {
      if (written) return
      written = true
      const record = {
        ...snapshot(t, "request", outcome, error),
        durationMs: endedAt - t.startedAt,
      }
      safeWrite(record)
      if (t.warned) options.onRecovered?.(record)
    }
    const decoder = t.decoder
    if (!decoder) {
      write()
      return
    }
    // Let buffered compressed bytes surface their SSE events before recording.
    decoder.once("close", write)
    setTimeout(write, 1_000).unref()
    decoder.end()
  }

  const scanText = (t: Tracked, text: string) => {
    t.lineBuffer += text
    const lines = t.lineBuffer.split("\n")
    t.lineBuffer = (lines.pop() ?? "").slice(-MAX_LINE_BUFFER)
    for (const line of lines) {
      const match = /^event:\s*(\S+)/.exec(line)
      if (!match) continue
      if (match[1] === "ping") {
        t.pings++
        if (t.firstEventAt === undefined) t.pingsBeforeFirstEvent++
        continue
      }
      const at = now()
      t.events++
      if (t.lastEventAt !== undefined)
        t.maxEventGapMs = Math.max(t.maxEventGapMs, at - t.lastEventAt)
      t.lastEventAt = at
      if (t.firstEventAt === undefined) {
        t.firstEventAt = at
        if (t.warned && live.has(t))
          options.onRecovered?.(snapshot(t, "request", "in-flight"))
      }
    }
  }

  const onCreate = (message: unknown) => {
    const request = (message as { request?: UndiciRequestLike }).request
    if (!request) return
    const origin = toText(request.origin ?? "")
    const path = toText(request.path ?? "")
    if (!options.hosts.includes(originHost(origin)) || !isMessagesPath(path))
      return
    const t: Tracked = {
      request,
      startedAt: now(),
      origin,
      path,
      tag: options.takeTag?.(),
      reqBytes: 0,
      pingsBeforeFirstEvent: 0,
      pings: 0,
      events: 0,
      maxEventGapMs: 0,
      bytes: 0,
      maxGapMs: 0,
      lineBuffer: "",
      headers: {},
      warned: false,
      stallAborted: false,
    }
    tracked.set(request as object, t)
    live.add(t)
  }

  const lookup = (message: unknown): Tracked | undefined => {
    const request = (message as { request?: object }).request
    return request ? tracked.get(request) : undefined
  }

  const onBodyChunkSent = (message: unknown) => {
    const t = lookup(message)
    if (!t) return
    const chunk = (message as { chunk?: unknown }).chunk
    if (typeof chunk === "string") t.reqBytes += Buffer.byteLength(chunk)
    else if (chunk instanceof Uint8Array) t.reqBytes += chunk.byteLength
  }

  const onHeaders = (message: unknown) => {
    const t = lookup(message)
    if (!t) return
    const response = (
      message as { response?: { statusCode?: number; headers?: unknown } }
    ).response
    t.status = response?.statusCode
    t.headersAt = now()
    t.headers = parseRawHeaders(response?.headers)
    t.decoder = createDecoder(t.headers["content-encoding"])
    t.decoder?.on("data", (data: Buffer) => scanText(t, data.toString("utf8")))
    t.decoder?.on("error", () => {
      // Undecodable bodies lose event timing; byte timing still works.
    })
  }

  const onChunk = (message: unknown) => {
    const t = lookup(message)
    if (!t) return
    const at = now()
    const chunk = (message as { chunk?: unknown }).chunk
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : undefined
    if (!bytes) return
    t.bytes += bytes.byteLength
    if (t.lastChunkAt !== undefined)
      t.maxGapMs = Math.max(t.maxGapMs, at - t.lastChunkAt)
    t.lastChunkAt = at
    // Chunks are raw wire bytes, before undici decompresses them for fetch.
    if (t.decoder) t.decoder.write(bytes)
    else scanText(t, bytes.toString("utf8"))
  }

  const onTrailers = (message: unknown) => {
    const t = lookup(message)
    if (t) finish(t, t.stallAborted ? "stall-abort" : "complete")
  }

  const onError = (message: unknown) => {
    const t = lookup(message)
    if (!t) return
    const err = (message as { error?: unknown }).error
    finish(
      t,
      t.stallAborted ? "stall-abort" : "error",
      err instanceof Error ? err.message : toText(err)
    )
  }

  const tick = () => {
    const at = now()
    for (const t of live) {
      // Undici should always publish trailers or error; this only bounds memory if it does not.
      if (at - t.startedAt > MAX_TRACK_MS) {
        finish(t, "error", "stall-probe lost track of request end")
        continue
      }
      if (t.firstEventAt === undefined) {
        if (!t.warned && at - t.startedAt >= options.warnAfterMs) {
          t.warned = true
          const record = snapshot(t, "stall-warning", "in-flight")
          safeWrite(record)
          options.onStall?.(record, true)
        } else if (t.warned) {
          options.onStall?.(snapshot(t, "stall-warning", "in-flight"), false)
        }
      }
      if (t.stallAborted || t.headersAt === undefined) continue
      const eventIdleMs = options.eventIdleMs ?? 0
      if (t.firstEventAt === undefined) {
        // Before message_start the stricter header-relative limit applies when set.
        const limit =
          options.abortAfterHeadersMs > 0
            ? options.abortAfterHeadersMs
            : eventIdleMs
        if (limit > 0 && at - t.headersAt >= limit) {
          const seconds = Math.round((at - t.headersAt) / 1000)
          abort(
            t,
            "stall-abort",
            `no message_start ${seconds}s after HTTP ${t.status} headers (${t.pingsBeforeFirstEvent} pings)`
          )
        }
      } else if (
        eventIdleMs > 0 &&
        t.lastEventAt !== undefined &&
        at - t.lastEventAt >= eventIdleMs
      ) {
        const seconds = Math.round((at - t.lastEventAt) / 1000)
        abort(
          t,
          "event-idle-abort",
          `no stream event for ${seconds}s after ${t.events} events (${t.pings} pings total)`
        )
      }
    }
  }

  const abort = (
    t: Tracked,
    kind: "stall-abort" | "event-idle-abort",
    reason: string
  ) => {
    if (typeof t.request.abort !== "function" || t.request.aborted) return
    t.stallAborted = true
    safeWrite(snapshot(t, kind, "in-flight"))
    try {
      t.request.abort(
        new Error(
          `Anthropic stream stalled: ${reason}; timed out by anthropic-stall-probe`
        )
      )
    } catch {
      // If undici refuses the abort, the warning path still reports the stall.
    }
  }

  const subscriptions: Array<[string, (message: unknown) => void]> = [
    ["undici:request:create", onCreate],
    ["undici:request:bodyChunkSent", onBodyChunkSent],
    ["undici:request:headers", onHeaders],
    ["undici:request:bodyChunkReceived", onChunk],
    ["undici:request:trailers", onTrailers],
    ["undici:request:error", onError],
  ]
  for (const [name, handler] of subscriptions)
    diagnosticsChannel.subscribe(name, handler)

  return {
    tick,
    inFlight: () => live.size,
    dispose: () => {
      for (const [name, handler] of subscriptions)
        diagnosticsChannel.unsubscribe(name, handler)
      live.clear()
    },
  }
}
