import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { searchExa, searchParallel } from "./providers"

const KEYS = [
  "WEB_TOOLS_EXA_API_KEY",
  "WEB_TOOLS_PARALLEL_API_KEY",
  "WEB_TOOLS_TAVILY_API_KEY",
  "WEB_TOOLS_YOU_API_KEY",
  "WEB_TOOLS_FIRECRAWL_API_KEY",
]

const realFetch = globalThis.fetch
let requests: Array<{ url: string; body: any }>
let respond: (url: string, body: any) => Response

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
}

beforeEach(() => {
  for (const key of KEYS) process.env[key] = "test-key"
  requests = []
  respond = () => json({ results: [] })
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    requests.push({ url, body })
    return respond(url, body)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const key of KEYS) delete process.env[key]
})

describe("error reporting", () => {
  test("non-2xx responses throw with status and body instead of returning null", async () => {
    respond = () => json({ error: "numResults must be <= 100" }, 400)
    await expect(searchExa({ query: "q", limit: 10 })).rejects.toThrow(
      'HTTP 400: {"error":"numResults must be <= 100"}'
    )
  })

  test("missing API key still skips the provider", async () => {
    delete process.env.WEB_TOOLS_EXA_API_KEY
    expect(await searchExa({ query: "q", limit: 10 })).toBeNull()
    expect(requests).toHaveLength(0)
  })
})

describe("parallel", () => {
  test("returns warnings separately from results", async () => {
    respond = () =>
      json({
        results: [{ url: "https://a.dev", title: "A", excerpts: ["one", "two"] }],
        warnings: [{ type: "warning", message: "max_results capped at 20" }],
      })
    const out = await searchParallel({ query: "q", limit: 5 })
    expect(out?.warnings).toEqual(["max_results capped at 20"])
    expect(out?.results[0].snippet).toBe("one\ntwo")
  })
})
