// Throws on HTTP/network errors; returns null only when the API key is unset.
import { postJsonOrThrow as postJson } from "./http"

export interface TavilyExtractParams {
  urls: string | string[]
  query?: string
  chunks_per_source?: number
  extract_depth?: "basic" | "advanced"
  format?: "markdown" | "text"
}

/** POST /extract 200 response (https://docs.tavily.com/documentation/api-reference/endpoint/extract). */
export interface TavilyExtractResponse {
  /** Successful URLs only; output order is not guaranteed. */
  results?: Array<{
    url: string
    /** Full page, or the top-ranked chunks joined by "[...]" when `query` is set. */
    raw_content: string
    images?: string[]
    favicon?: string
  }>
  failed_results?: Array<{ url: string; error: string }>
  response_time?: number
  usage?: { credits?: number }
  request_id?: string
}

export async function extractTavily(
  params: TavilyExtractParams,
  signal?: AbortSignal
): Promise<TavilyExtractResponse | null> {
  return postJson({
    url: "https://api.tavily.com/extract",
    apiKeyEnv: "WEB_TOOLS_TAVILY_API_KEY",
    headers: (apiKey) => ({
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    }),
    body: params,
    signal,
  })
}
