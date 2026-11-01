import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { runWebExtract } from "../extract/pipeline"
import { searchParallel } from "../search/providers"
import { fetchAndExtract } from "./pipeline"

const KEYS = [
  "WEB_TOOLS_JINA_API_KEY",
  "WEB_TOOLS_FIRECRAWL_API_KEY",
  "WEB_TOOLS_PARALLEL_API_KEY",
  "WEB_TOOLS_EXA_API_KEY",
  "WEB_TOOLS_TAVILY_API_KEY",
  "WEB_TOOLS_YOU_API_KEY",
]
const TARGET = "https://target.dev/page"

const realFetch = globalThis.fetch
const savedEnv: Record<string, string | undefined> = {}
let requests: Array<{ url: string; init: RequestInit }>
let respond: (url: string, init: RequestInit) => Response

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
}

function html(body: string, status = 200) {
  return new Response(`<html><head><title>T</title></head><body><article>${body}</article></body></html>`, {
    status,
    headers: { "Content-Type": "text/html" },
  })
}

beforeEach(() => {
  for (const key of [...KEYS, "WEB_TOOLS_FETCH_STAGE"]) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  requests = []
  respond = () => new Response("not found", { status: 404 })
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    requests.push({ url: String(url), init })
    return respond(String(url), init)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("fetch provider errors", () => {
  test("records why each provider failed when a later stage succeeds", async () => {
    process.env.WEB_TOOLS_JINA_API_KEY = "k"
    process.env.WEB_TOOLS_EXA_API_KEY = "k"
    respond = (url) => {
      if (url === "https://r.jina.ai/") return json({ code: 422, message: "bad url" }, 422)
      if (url === "https://api.exa.ai/contents") {
        return json({
          results: [],
          statuses: [{ id: TARGET, status: "error", error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } }],
        })
      }
      if (url === "https://markdown.new/") return new Response("", { status: 429 })
      return html("<h1>Hello</h1><p>Body text that is long enough to be kept by the extractor.</p>")
    }
    const result = await fetchAndExtract(TARGET)
    expect(result.stage).toBe("defuddle")
    expect(result.providerErrors).toEqual([
      'jina-ai: HTTP 422: {"code":422,"message":"bad url"}',
      "exa: CRAWL_NOT_FOUND (HTTP 404)",
      "markdown-new: HTTP 429",
    ])
  })

  test("includes provider errors when every stage fails", async () => {
    process.env.WEB_TOOLS_TAVILY_API_KEY = "k"
    respond = (url) => {
      if (url === "https://api.tavily.com/extract") {
        return json({ results: [], failed_results: [{ url: TARGET, error: "Failed to retrieve content" }] })
      }
      return new Response("gone", { status: 410, statusText: "Gone" })
    }
    await expect(fetchAndExtract(TARGET)).rejects.toThrow(
      "HTTP 410: Gone. Providers tried: tavily: Failed to retrieve content; markdown-new: HTTP 410"
    )
  })

  test("unconfigured providers are skipped without an error entry", async () => {
    respond = (url) =>
      url === "https://markdown.new/"
        ? json({ success: true, url: TARGET, title: "Converted Content", content: "# From markdown.new\n\ntext" })
        : new Response("", { status: 404 })
    const result = await fetchAndExtract(TARGET)
    expect(result.stage).toBe("markdown-new")
    expect(result.title).toBe("From markdown.new")
    expect(result.providerErrors).toBeUndefined()
  })

  test("markdown.new: POSTs the target URL so its query string stays intact", async () => {
    const withQuery = `${TARGET}?method=browser&retain_images=true`
    respond = (url) =>
      url === "https://markdown.new/" ? json({ success: true, content: "text" }) : new Response("", { status: 404 })
    await fetchAndExtract(withQuery)
    const call = requests.find((r) => r.url === "https://markdown.new/")
    expect(call?.init.method).toBe("POST")
    expect(JSON.parse(String(call?.init.body))).toEqual({ url: withQuery })
  })

  test("a forced stage reports the provider's reason", async () => {
    process.env.WEB_TOOLS_FETCH_STAGE = "parallel"
    process.env.WEB_TOOLS_PARALLEL_API_KEY = "k"
    respond = () =>
      json({ results: [], errors: [{ url: TARGET, error_type: "fetch_error", http_status_code: 403 }] })
    await expect(fetchAndExtract(TARGET)).rejects.toThrow(
      'Extractor "parallel" failed: fetch_error (HTTP 403)'
    )
  })
})

describe("target error pages", () => {
  test("firecrawl: a 200 response wrapping a 404 page is a failure", async () => {
    process.env.WEB_TOOLS_FETCH_STAGE = "firecrawl"
    process.env.WEB_TOOLS_FIRECRAWL_API_KEY = "k"
    respond = () =>
      json({
        success: true,
        data: { markdown: "# Not Found", metadata: { statusCode: 404, error: "Not Found" } },
      })
    await expect(fetchAndExtract(TARGET)).rejects.toThrow(
      'Extractor "firecrawl" failed: target page returned HTTP 404: Not Found'
    )
  })

  test("jina: asks Reader to reject non-200 target pages", async () => {
    process.env.WEB_TOOLS_FETCH_STAGE = "jina-ai"
    process.env.WEB_TOOLS_JINA_API_KEY = "k"
    respond = () => json({ data: { content: "Hello", title: "T" } })
    await fetchAndExtract(TARGET)
    const headers = requests[0].init.headers as Record<string, string>
    expect(headers["X-Assert-Status-Code"]).toBe("200")
  })
})

describe("exa contents request", () => {
  test("sends the documented urls field, not legacy ids", async () => {
    process.env.WEB_TOOLS_FETCH_STAGE = "exa"
    process.env.WEB_TOOLS_EXA_API_KEY = "k"
    respond = () => json({ results: [{ id: TARGET, text: "page text" }], statuses: [{ id: TARGET, status: "success" }] })
    await fetchAndExtract(TARGET)
    const body = JSON.parse(String(requests[0].init.body))
    expect(body).toEqual({ urls: [TARGET], text: { verbosity: "full" } })
  })
})

describe("parallel sessions", () => {
  test("search, fetch and extract share one Parallel session per pi session", async () => {
    process.env.WEB_TOOLS_PARALLEL_API_KEY = "k"
    respond = (url, init) => {
      const body = JSON.parse(String(init.body))
      const session = body.session_id ?? `S-${requests.length}`
      if (url === "https://api.parallel.ai/v1/search") return json({ results: [], session_id: session })
      return json({ results: [{ url: TARGET, full_content: "full", excerpts: ["e"] }], session_id: session })
    }
    await searchParallel({ query: "q", limit: 3, sessionKey: "pi-x" })
    process.env.WEB_TOOLS_FETCH_STAGE = "parallel"
    await fetchAndExtract(TARGET, undefined, "pi-x")
    await runWebExtract({} as any, { urls: [TARGET], mode: "targeted", prompt: "p", sessionKey: "pi-x" })
    await fetchAndExtract(TARGET, undefined, "pi-y")
    await fetchAndExtract(TARGET)
    const sessions = requests.map((r) => JSON.parse(String(r.init.body)).session_id)
    expect(sessions).toEqual([undefined, "S-1", "S-1", undefined, undefined])
  })

  test("fetch labels excerpts when Parallel has no full content", async () => {
    process.env.WEB_TOOLS_FETCH_STAGE = "parallel"
    process.env.WEB_TOOLS_PARALLEL_API_KEY = "k"
    respond = () => json({ results: [{ url: TARGET, excerpts: ["one", "two"] }] })
    const result = await fetchAndExtract(TARGET)
    expect(result.content).toBe(
      "> Parallel returned excerpts only; the full page content was unavailable.\n\none\n\ntwo"
    )
  })
})
