import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { extractExa } from "./exa"
import { extractParallelTargeted } from "./parallel"
import { extractTavilyTargeted } from "./tavily"

const KEYS = ["WEB_TOOLS_EXA_API_KEY", "WEB_TOOLS_PARALLEL_API_KEY", "WEB_TOOLS_TAVILY_API_KEY"]
const A = "https://a.dev/page"
const B = "https://b.dev/page"
const C = "https://c.dev/page"

const realFetch = globalThis.fetch
let requests: Array<{ url: string; body: any }>
let respond: (url: string, body: any) => Response

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
}

beforeEach(() => {
  for (const key of KEYS) process.env[key] = "test-key"
  requests = []
  respond = () => json({})
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

function contentOf(items: Awaited<ReturnType<typeof extractExa>>) {
  return items?.map((item) => item?.content ?? item?.excerpts?.join("|") ?? null)
}

describe("result matching", () => {
  test("exa: failed URL omitted from results does not shift later URLs", async () => {
    respond = () =>
      json({
        results: [
          { id: C, url: C, summary: "summary of C" },
          { id: A, url: A, summary: "summary of A" },
        ],
        statuses: [
          { id: A, status: "success" },
          { id: B, status: "error", error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } },
          { id: C, status: "success" },
        ],
      })
    const out = await extractExa({ urls: [A, B, C], mode: "summary" })
    expect(contentOf(out)).toEqual(["summary of A", null, "summary of C"])
  })

  test("parallel: matches by url when a URL fails and results are reordered", async () => {
    respond = () =>
      json({
        results: [
          { url: C, excerpts: ["C excerpt"] },
          { url: A, excerpts: ["A excerpt"] },
        ],
        errors: [{ url: B, error_type: "fetch_error", http_status_code: 404 }],
      })
    const out = await extractParallelTargeted({ urls: [A, B, C], mode: "targeted", prompt: "p" })
    expect(contentOf(out)).toEqual(["A excerpt", null, "C excerpt"])
  })

  test("tavily: matches by url; output order is not guaranteed", async () => {
    respond = () =>
      json({
        results: [
          { url: C, raw_content: "C chunks" },
          { url: A, raw_content: "A chunks" },
        ],
        failed_results: [{ url: B, error: "Failed to retrieve content" }],
      })
    const out = await extractTavilyTargeted({ urls: [A, B, C], mode: "targeted", prompt: "p" })
    expect(contentOf(out)).toEqual(["A chunks", null, "C chunks"])
  })

  test("tolerates trailing-slash and fragment differences", async () => {
    respond = () => json({ results: [{ url: "https://a.dev/page/", raw_content: "A" }] })
    const out = await extractTavilyTargeted({
      urls: [`${A}#section`],
      mode: "targeted",
      prompt: "p",
    })
    expect(contentOf(out)).toEqual(["A"])
  })

  test("pairs a single leftover result with a single leftover URL (redirect)", async () => {
    respond = () =>
      json({
        results: [
          { url: A, excerpts: ["A"] },
          { url: "https://b.dev/redirected", excerpts: ["B"] },
        ],
      })
    const out = await extractParallelTargeted({ urls: [A, B], mode: "targeted", prompt: "p" })
    expect(contentOf(out)).toEqual(["A", "B"])
  })

  test("does not guess when several results are unmatched", async () => {
    respond = () =>
      json({
        results: [
          { url: "https://x.dev/1", raw_content: "X1" },
          { url: "https://x.dev/2", raw_content: "X2" },
        ],
      })
    const out = await extractTavilyTargeted({ urls: [A, B], mode: "targeted", prompt: "p" })
    expect(out).toBeNull()
  })

  test("only sends pending URLs and scatters results to their original index", async () => {
    respond = () => json({ results: [{ url: C, raw_content: "C" }] })
    const out = await extractTavilyTargeted({
      urls: [A, B, C],
      mode: "targeted",
      prompt: "p",
      pending: [false, false, true],
    })
    expect(requests[0].body.urls).toEqual([C])
    expect(contentOf(out)).toEqual([null, null, "C"])
  })
})

describe("per-URL provider errors", () => {
  test("explains why a URL failed across providers", async () => {
    const { runWebExtract } = await import("../pipeline")
    delete process.env.WEB_TOOLS_PARALLEL_API_KEY
    respond = (url) => {
      if (url === "https://api.exa.ai/contents") {
        return json({
          results: [{ id: A, url: A, summary: "A answer" }],
          statuses: [
            { id: A, status: "success" },
            { id: B, status: "error", error: { tag: "CRAWL_HTTP_403", httpStatusCode: 403 } },
          ],
        })
      }
      return json({ detail: { error: "All URLs failed validation." } }, 400)
    }
    const out = await runWebExtract({} as any, { urls: [A, B], mode: "targeted", prompt: "p" })
    expect(out.results[0]).toMatchObject({ url: A, source: "exa", content: "A answer" })
    expect(out.results[1].error).toBe(
      'No provider returned content for this URL (exa: CRAWL_HTTP_403 (HTTP 403); tavily: HTTP 400: {"detail":{"error":"All URLs failed validation."}})'
    )
    expect(requests.map((r) => r.url)).toEqual(["https://api.exa.ai/contents", "https://api.tavily.com/extract"])
    expect(requests[1].body.urls).toEqual([B])
  })
})
