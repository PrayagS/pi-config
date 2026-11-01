import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CONTENT_MAX_CHARS, searchExa, searchParallel, searchTavily, searchYou } from "./providers"

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
  test("uses fast mode, clamps max_results, and requests long excerpts for content", async () => {
    await searchParallel({ query: "q", limit: 50, includeContent: true })
    const { body } = requests[0]
    expect(body.mode).toBe("fast")
    expect(body.advanced_settings.max_results).toBe(20)
    expect(body.advanced_settings.excerpt_settings).toEqual({ max_chars_per_result: CONTENT_MAX_CHARS })
  })

  test("scopes session_id to the pi session", async () => {
    respond = (_url, body) => json({ results: [], session_id: `server-${body.session_id ?? "new"}` })
    await searchParallel({ query: "q", limit: 5, sessionKey: "pi-a" })
    await searchParallel({ query: "q", limit: 5, sessionKey: "pi-a" })
    await searchParallel({ query: "q", limit: 5, sessionKey: "pi-b" })
    await searchParallel({ query: "q", limit: 5 })
    expect(requests.map((r) => r.body.session_id)).toEqual([undefined, "server-new", undefined, undefined])
  })

  test("returns warnings separately from results", async () => {
    respond = () =>
      json({
        results: [{ url: "https://a.dev", title: "A", excerpts: ["one", "two"] }],
        warnings: [{ type: "warning", message: "max_results capped at 20" }],
      })
    const out = await searchParallel({ query: "q", limit: 5 })
    expect(out?.warnings).toEqual(["max_results capped at 20"])
    expect(out?.results[0].snippet).toBe("one\n\ntwo")
  })
})

describe("exa", () => {
  test("sends ISO date-time and capped text instead of summary", async () => {
    await searchExa({ query: "q", limit: 10, age: "week", includeContent: true })
    const { body } = requests[0]
    expect(body.startPublishedDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(body.contents).toEqual({ text: { maxCharacters: CONTENT_MAX_CHARS }, livecrawlTimeout: 5000 })
  })

  test("keeps highlights for the default snippet path", async () => {
    await searchExa({ query: "q", limit: 10 })
    expect(requests[0].body.contents).toEqual({ highlights: true, livecrawlTimeout: 5000 })
  })
})

describe("tavily", () => {
  test("requests published dates and caps raw_content", async () => {
    respond = () =>
      json({
        results: [
          {
            url: "https://a.dev",
            title: "A",
            content: "short",
            raw_content: "x".repeat(CONTENT_MAX_CHARS + 100),
            published_date: "2026-10-01",
          },
        ],
      })
    const out = await searchTavily({ query: "q", limit: 5, includeContent: true })
    expect(requests[0].body.include_published_date).toBe(true)
    expect(out?.results[0].published).toBe("2026-10-01")
    expect(out?.results[0].snippet?.startsWith("x".repeat(CONTENT_MAX_CHARS))).toBe(true)
    expect(out?.results[0].snippet).toContain("truncated; use web_fetch")
  })
})

describe("you.com", () => {
  test("uses extraction instead of deprecated livecrawl fields", async () => {
    await searchYou({ query: "q", limit: 10, includeContent: true })
    const { body } = requests[0]
    expect(body.livecrawl).toBeUndefined()
    expect(body.livecrawl_formats).toBeUndefined()
    expect(body.extraction).toEqual({
      extraction_mode: "full_page",
      full_page: { extraction_formats: ["markdown"] },
    })
    expect(body.crawl_timeout).toBe(8)
  })

  test("sends no extraction for the default path", async () => {
    await searchYou({ query: "q", limit: 10 })
    expect(requests[0].body.extraction).toBeUndefined()
    expect(requests[0].body.crawl_timeout).toBeUndefined()
  })

  test("reads snippets and contents.highlights ahead of description", async () => {
    respond = () =>
      json({
        results: {
          web: [
            { url: "https://a.dev", title: "A", description: "desc", snippets: ["s1", "s2"] },
            { url: "https://b.dev", title: "B", description: "desc", contents: { highlights: ["h1"] } },
          ],
        },
      })
    const out = await searchYou({ query: "q", limit: 10 })
    expect(out?.results.map((r) => r.snippet)).toEqual(["s1\n\ns2", "h1"])
  })
})
