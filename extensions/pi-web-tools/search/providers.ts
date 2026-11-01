import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { postJsonOrThrow as postJson } from "../providers/http"
import { buildKagiSearchArgs } from "../providers/kagi"
import { ageCutoff, ageCutoffDate } from "./age"
import type { SearchFilters, WebSearchResult } from "./types"

const TIMEOUT_MS = 15_000
/** Per-result cap for includeContent page text; full pages belong to web_fetch. */
export const CONTENT_MAX_CHARS = 8_000

export interface WebSearchProviderParams extends SearchFilters {
  query: string
  limit: number
  signal?: AbortSignal
  /** Stable id of the calling pi session, for providers with task sessions. */
  sessionKey?: string
}

export interface WebSearchProviderOutput {
  source: string
  results: WebSearchResult[]
  /** Provider-reported request warnings (e.g. ignored fields). Not shown to the model. */
  warnings?: string[]
}

export type WebSearchProvider = (
  params: WebSearchProviderParams
) => Promise<WebSearchProviderOutput | null>

function env(name: string) {
  return process.env[name]
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const found = text(value)
    if (found) return found
  }
  return undefined
}

function normalizeDate(value: unknown) {
  return text(value)
}

function capContent(value: string | undefined) {
  if (!value || value.length <= CONTENT_MAX_CHARS) return value
  return `${value.slice(0, CONTENT_MAX_CHARS)}\n\n[\u2026truncated; use web_fetch for the full page]`
}

function warningMessages(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const messages = value
    .map((w: any) => firstText(w?.message, typeof w === "string" ? w : undefined))
    .filter((m): m is string => Boolean(m))
  return messages.length > 0 ? messages : undefined
}

function normalizeResult(item: any, source: string): WebSearchResult | null {
  const url = firstText(item?.url, item?.link, item?.sourceUrl, item?.sourceURL)
  if (!url) return null
  const snippets = Array.isArray(item?.snippets)
    ? item.snippets.filter((s: unknown) => typeof s === "string")
    : Array.isArray(item?.highlights)
      ? item.highlights.filter((s: unknown) => typeof s === "string")
      : Array.isArray(item?.excerpts)
        ? item.excerpts.filter((s: unknown) => typeof s === "string")
        : undefined
  const snippet = firstText(
    item?.markdown,
    item?.raw_content,
    item?.contents?.markdown,
    item?.snippet,
    item?.description,
    item?.content,
    item?.text,
    item?.summary,
    snippets?.join("\n")
  )
  return {
    title: firstText(item?.title, item?.name) ?? url,
    url,
    snippet: capContent(snippet),
    published: normalizeDate(
      item?.published ??
        item?.publishedDate ??
        item?.publish_date ??
        item?.published_date ??
        item?.date ??
        item?.page_age
    ),
    source,
  }
}

function compact(results: Array<WebSearchResult | null>, limit: number) {
  return results.filter((r): r is WebSearchResult => Boolean(r)).slice(0, limit)
}

export function createKagiSearchProvider(pi: ExtensionAPI): WebSearchProvider {
  return async ({ query, limit, signal, sessionKey: _sessionKey, ...filters }) => {
    const { stdout, stderr, code } = await pi.exec("kagi", buildKagiSearchArgs(query, filters), {
      signal,
      timeout: TIMEOUT_MS,
    })
    if (code !== 0) throw new Error(stderr.trim() || `exit code ${code}`)
    const response = JSON.parse(stdout)
    const results = compact(
      (response.data ?? [])
        .filter((item: any) => item.t === 0)
        .map((item: any) =>
          normalizeResult(
            {
              title: item.title,
              url: item.url,
              snippet: item.snippet,
              published: item.published,
            },
            "kagi"
          )
        ),
      limit
    )
    return { source: "kagi", results }
  }
}

export const searchFirecrawl: WebSearchProvider = async ({
  query,
  limit,
  age,
  includeDomains,
  excludeDomains,
  includeContent,
  signal,
}) => {
  const body: Record<string, unknown> = { query, limit }
  if (age) body.tbs = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" }[age]
  if (includeDomains?.length) body.includeDomains = includeDomains
  if (excludeDomains?.length) body.excludeDomains = excludeDomains
  if (includeContent) body.scrapeOptions = { formats: [{ type: "markdown" }] }
  const json = await postJson<any>({
    url: "https://api.firecrawl.dev/v2/search",
    apiKeyEnv: "WEB_TOOLS_FIRECRAWL_API_KEY",
    headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }),
    body,
    signal,
    timeout: TIMEOUT_MS,
  })
  if (!json) return null
  return {
    source: "firecrawl",
    results: compact((json.data?.web ?? json.web ?? []).map((i: any) => normalizeResult(i, "firecrawl")), limit)
  }
}

export const searchTavily: WebSearchProvider = async ({
  query,
  limit,
  age,
  includeDomains,
  excludeDomains,
  includeContent,
  signal,
}) => {
  const json = await postJson<any>({
    url: "https://api.tavily.com/search",
    apiKeyEnv: "WEB_TOOLS_TAVILY_API_KEY",
    headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }),
    body: {
      query,
      max_results: Math.min(limit, 20),
      search_depth: "basic",
      chunks_per_source: 1,
      time_range: age,
      // published_date is omitted from results unless requested (or topic=news).
      include_published_date: true,
      include_domains: includeDomains,
      exclude_domains: excludeDomains,
      include_raw_content: includeContent ? "markdown" : false,
    },
    signal,
    timeout: TIMEOUT_MS,
  })
  if (!json) return null
  return { source: "tavily", results: compact((json.results ?? []).map((i: any) => normalizeResult(i, "tavily")), limit) }
}

/** Parallel session ids keyed by pi session, so each pi task gets its own Parallel session. */
const parallelSessionIds = new Map<string, string>()
const PARALLEL_MAX_RESULTS = 20

export const searchParallel: WebSearchProvider = async ({
  query,
  limit,
  age,
  includeDomains,
  excludeDomains,
  includeContent,
  signal,
  sessionKey,
}) => {
  const body: any = {
    objective: query,
    search_queries: [query],
    // Default is "advanced" (~3s); "fast" is Parallel's recommended agent mode (~1s).
    mode: "fast",
    advanced_settings: { max_results: Math.min(limit, PARALLEL_MAX_RESULTS) },
  }
  // Search only returns excerpts; ask for longer ones when page content is wanted.
  if (includeContent) {
    body.advanced_settings.excerpt_settings = { max_chars_per_result: CONTENT_MAX_CHARS }
  }
  const sourcePolicy: Record<string, unknown> = {}
  const afterDate = ageCutoffDate(age)
  if (afterDate) sourcePolicy.after_date = afterDate
  if (includeDomains?.length) sourcePolicy.include_domains = includeDomains
  if (excludeDomains?.length) sourcePolicy.exclude_domains = excludeDomains
  if (Object.keys(sourcePolicy).length > 0) body.advanced_settings.source_policy = sourcePolicy
  const parallelSessionId = sessionKey ? parallelSessionIds.get(sessionKey) : undefined
  if (parallelSessionId) body.session_id = parallelSessionId
  const json = await postJson<any>({
    url: "https://api.parallel.ai/v1/search",
    apiKeyEnv: "WEB_TOOLS_PARALLEL_API_KEY",
    headers: (apiKey) => ({ "x-api-key": apiKey, "Content-Type": "application/json" }),
    body,
    signal,
    timeout: TIMEOUT_MS,
  })
  if (!json) return null
  if (sessionKey && typeof json.session_id === "string") {
    parallelSessionIds.set(sessionKey, json.session_id)
  }
  return {
    source: "parallel",
    results: compact((json.results ?? []).map((i: any) => normalizeResult(i, "parallel")), limit),
    warnings: warningMessages(json.warnings),
  }
}

export const searchExa: WebSearchProvider = async ({
  query,
  limit,
  age,
  includeDomains,
  excludeDomains,
  includeContent,
  signal,
}) => {
  const json = await postJson<any>({
    url: "https://api.exa.ai/search",
    apiKeyEnv: "WEB_TOOLS_EXA_API_KEY",
    headers: (apiKey) => ({ "x-api-key": apiKey, "Content-Type": "application/json" }),
    body: {
      query,
      type: "auto",
      numResults: limit,
      startPublishedDate: ageCutoff(age)?.toISOString(),
      includeDomains,
      excludeDomains,
      contents: {
        // Capped page text instead of `summary`, which runs an extra paid LLM call per page.
        ...(includeContent
          ? { text: { maxCharacters: CONTENT_MAX_CHARS } }
          : { highlights: true }),
        // Default livecrawl timeout is 10s; leave room inside our 15s budget.
        livecrawlTimeout: 5_000,
      },
    },
    signal,
    timeout: TIMEOUT_MS,
  })
  if (!json) return null
  return {
    source: "exa",
    results: compact((json.results ?? []).map((i: any) => normalizeResult(i, "exa")), limit),
    warnings: warningMessages(json.warnings),
  }
}

export const searchYou: WebSearchProvider = async ({
  query,
  limit,
  age,
  includeDomains,
  excludeDomains,
  includeContent,
  signal,
}) => {
  const json = await postJson<any>({
    url: "https://ydc-index.io/v1/search",
    apiKeyEnv: "WEB_TOOLS_YOU_API_KEY",
    headers: (apiKey) => ({ "X-API-Key": apiKey, "Content-Type": "application/json" }),
    body: {
      query,
      count: limit,
      freshness: age,
      include_domains: includeDomains,
      exclude_domains: excludeDomains,
      livecrawl: includeContent ? "all" : undefined,
      livecrawl_formats: includeContent ? ["markdown"] : undefined,
    },
    signal,
    timeout: TIMEOUT_MS,
  })
  if (!json) return null
  const items = [...(json.results?.web ?? []), ...(json.results?.news ?? [])]
  return {
    source: "you",
    results: compact(
      items.map((i: any) =>
        normalizeResult(
          {
            ...i,
            snippet: Array.isArray(i?.snippets)
              ? i.snippets.filter((s: unknown) => typeof s === "string").join("\n")
              : i?.snippet,
          },
          "you"
        )
      ),
      limit
    )
  }
}
