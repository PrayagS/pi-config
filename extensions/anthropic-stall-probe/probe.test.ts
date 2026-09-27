// Run with: node --test extensions/anthropic-stall-probe/probe.test.ts
// Uses Node's fetch, whose bundled undici publishes the same diagnostics channels as Pi's.
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, test } from "node:test"
import zlib from "node:zlib"
import { createProbe, type ProbeRecord } from "./probe.ts"

let server: Server
let host: string
const timers = new Set<NodeJS.Timeout>()

function sse(
  res: { write: (text: string) => unknown },
  event: string,
  data: unknown
) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

before(async () => {
  server = createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      const gzip = req.url?.includes("gzip")
      res.writeHead(200, {
        "content-type": "text/event-stream",
        ...(gzip ? { "content-encoding": "gzip" } : {}),
        "request-id": "req_test",
        "anthropic-ratelimit-unified-overage-in-use": "true",
        authorization: "must-not-be-logged",
      })
      // Compressed SSE must be flushed per event, as a real server does.
      const z = gzip ? zlib.createGzip() : undefined
      z?.pipe(res)
      const out = {
        write: (text: string) => {
          if (!z) return res.write(text)
          z.write(text)
          z.flush()
        },
        end: () => (z ? z.end() : res.end()),
      }
      if (req.url?.includes("stall")) {
        sse(out, "ping", { type: "ping" })
        // midstall: the stream starts normally, then only pings arrive.
        if (req.url.includes("midstall"))
          sse(out, "message_start", {
            type: "message_start",
            message: { id: "msg_2" },
          })
        const timer = setInterval(() => sse(out, "ping", { type: "ping" }), 50)
        timers.add(timer)
        res.on("close", () => clearInterval(timer))
        return
      }
      sse(out, "ping", { type: "ping" })
      sse(out, "message_start", {
        type: "message_start",
        message: { id: "msg_1" },
      })
      sse(out, "message_stop", { type: "message_stop" })
      out.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => {
  for (const timer of timers) clearInterval(timer)
  server.closeAllConnections()
  server.close()
})

for (const encoding of ["identity", "gzip"]) {
  test(`records a healthy ${encoding} stream with headers and first-event timing`, async () => {
    const records: ProbeRecord[] = []
    const probe = createProbe({
      hosts: [host],
      warnAfterMs: 10_000,
      abortAfterHeadersMs: 0,
      write: (r) => records.push(r),
      takeTag: () => ({ model: "claude-test" }),
    })
    try {
      const res = await fetch(
        `http://${host}/v1/messages?beta=true&${encoding}`,
        { method: "POST", body: "{}" }
      )
      await res.text()
      await new Promise((r) => setTimeout(r, 20))
    } finally {
      probe.dispose()
    }
    const done = records.find((r) => r.kind === "request")
    assert.ok(done, JSON.stringify(records))
    assert.equal(done.outcome, "complete")
    assert.equal(done.status, 200)
    assert.equal(done.model, "claude-test")
    assert.equal(done.pingsBeforeFirstEvent, 1)
    assert.ok(done.firstEventMs !== undefined)
    assert.equal(done.headers["request-id"], "req_test")
    assert.equal(
      done.headers["anthropic-ratelimit-unified-overage-in-use"],
      "true"
    )
    assert.equal(done.headers.authorization, undefined)
    assert.ok(done.reqBytes >= 2)
  })
}

test("ignores non-messages paths and other hosts", async () => {
  const records: ProbeRecord[] = []
  const probe = createProbe({
    hosts: ["api.anthropic.com"],
    warnAfterMs: 0,
    abortAfterHeadersMs: 0,
    write: (r) => records.push(r),
  })
  try {
    await (
      await fetch(`http://${host}/v1/messages`, { method: "POST", body: "{}" })
    ).text()
    probe.tick()
  } finally {
    probe.dispose()
  }
  assert.deepEqual(records, [])
})

for (const encoding of ["identity", "gzip"]) {
  test(`warns on a ping-only ${encoding} stream and aborts it with a retryable error when enabled`, async () => {
    const records: ProbeRecord[] = []
    const stalls: Array<[ProbeRecord, boolean]> = []
    const probe = createProbe({
      hosts: [host],
      warnAfterMs: 150,
      abortAfterHeadersMs: 300,
      write: (r) => records.push(r),
      onStall: (r, first) => stalls.push([r, first]),
    })
    const ticker = setInterval(probe.tick, 25)
    let readError: unknown
    try {
      const res = await fetch(
        `http://${host}/v1/messages?stall=1&${encoding}`,
        { method: "POST", body: "{}" }
      )
      assert.ok(res.body)
      const reader = res.body.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
    } catch (err) {
      readError = err
    } finally {
      clearInterval(ticker)
      // Compressed requests record after their decoder drains.
      await new Promise((r) => setTimeout(r, 50))
      probe.dispose()
    }
    assert.ok(readError, "stalled stream should reject reader.read()")
    const text = `${(readError as Error).message} ${String((readError as Error & { cause?: Error }).cause?.message ?? "")}`
    // Pi's retry classifier treats "terminated" and "timed out" as retryable.
    assert.match(text, /terminated|timed out/i)
    assert.equal(stalls.filter(([, first]) => first).length, 1)
    assert.ok(records.some((r) => r.kind === "stall-warning"))
    assert.ok(records.some((r) => r.kind === "stall-abort"))
    const done = records.find((r) => r.kind === "request")
    assert.ok(done, JSON.stringify(records))
    assert.equal(done.outcome, "stall-abort")
    assert.equal(done.firstEventMs, undefined)
    assert.ok(done.pingsBeforeFirstEvent >= 3)
  })
}

async function drain(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { method: "POST", body: "{}" })
    assert.ok(res.body)
    const reader = res.body.getReader()
    while (!(await reader.read()).done) {}
    return undefined
  } catch (err) {
    return err
  }
}

for (const encoding of ["identity", "gzip"]) {
  test(`event-level watchdog aborts a ${encoding} stream that goes ping-only after message_start`, async () => {
    const records: ProbeRecord[] = []
    const probe = createProbe({
      hosts: [host],
      warnAfterMs: 60_000,
      abortAfterHeadersMs: 60_000,
      eventIdleMs: 300,
      write: (r) => records.push(r),
    })
    const ticker = setInterval(probe.tick, 25)
    const err = await drain(`http://${host}/v1/messages?midstall=1&${encoding}`)
    clearInterval(ticker)
    await new Promise((r) => setTimeout(r, 50))
    probe.dispose()
    assert.ok(err, "mid-stream stall should reject")
    assert.ok(
      records.some((r) => r.kind === "event-idle-abort"),
      JSON.stringify(records)
    )
    assert.ok(
      !records.some(
        (r) => r.kind === "stall-warning" || r.kind === "stall-abort"
      )
    )
    const done = records.find((r) => r.kind === "request")
    assert.ok(done)
    assert.equal(done.outcome, "stall-abort")
    assert.equal(done.events, 1)
    assert.ok(done.pings >= 3)
  })
}

test("event-level watchdog also covers the pre-message_start gap when the header limit is off", async () => {
  const records: ProbeRecord[] = []
  const probe = createProbe({
    hosts: [host],
    warnAfterMs: 60_000,
    abortAfterHeadersMs: 0,
    eventIdleMs: 300,
    write: (r) => records.push(r),
  })
  const ticker = setInterval(probe.tick, 25)
  const err = await drain(`http://${host}/v1/messages?stall=1`)
  clearInterval(ticker)
  await new Promise((r) => setTimeout(r, 50))
  probe.dispose()
  assert.ok(err)
  assert.ok(records.some((r) => r.kind === "stall-abort"))
})

test("event-level watchdog leaves a healthy stream alone", async () => {
  const records: ProbeRecord[] = []
  const probe = createProbe({
    hosts: [host],
    warnAfterMs: 60_000,
    abortAfterHeadersMs: 0,
    eventIdleMs: 200,
    write: (r) => records.push(r),
  })
  const ticker = setInterval(probe.tick, 5)
  const err = await drain(`http://${host}/v1/messages?gzip`)
  clearInterval(ticker)
  await new Promise((r) => setTimeout(r, 50))
  probe.dispose()
  assert.equal(err, undefined)
  assert.equal(records.find((r) => r.kind === "request")?.events, 2)
})
