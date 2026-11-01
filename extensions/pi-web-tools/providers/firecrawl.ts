// Throws on HTTP/network errors; returns null only when the API key is unset.
import { postJsonOrThrow as postJson } from "./http"

export interface FirecrawlScrapeParams {
  url: string
  formats: Array<string | Record<string, unknown>>
}

/**
 * Firecrawl returns 200 even when the target page failed; the page's own status
 * is in data.metadata.statusCode / data.metadata.error.
 */
export function firecrawlPageError(metadata: any): string | undefined {
  const status = typeof metadata?.statusCode === "number" ? metadata.statusCode : undefined
  const error = typeof metadata?.error === "string" && metadata.error.trim() ? metadata.error.trim() : undefined
  if (status !== undefined && status >= 400) {
    return error ? `target page returned HTTP ${status}: ${error}` : `target page returned HTTP ${status}`
  }
  return error ? `target page error: ${error}` : undefined
}

export async function scrapeFirecrawl(
  params: FirecrawlScrapeParams,
  signal?: AbortSignal
): Promise<any | null> {
  return postJson({
    url: "https://api.firecrawl.dev/v2/scrape",
    apiKeyEnv: "WEB_TOOLS_FIRECRAWL_API_KEY",
    headers: (apiKey) => ({
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    }),
    body: params,
    signal,
  })
}
