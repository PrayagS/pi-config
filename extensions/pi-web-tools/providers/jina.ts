// Throws on HTTP/network errors; returns null only when the API key is unset.
import { postJsonOrThrow as postJson } from "./http"

export interface JinaReaderParams {
  url: string
  rawHtml?: boolean
}

export async function fetchJinaReader(
  params: JinaReaderParams,
  signal?: AbortSignal
): Promise<any | null> {
  return postJson({
    url: "https://r.jina.ai/",
    apiKeyEnv: "WEB_TOOLS_JINA_API_KEY",
    headers: (apiKey) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        // Reject (HTTP 422) instead of returning a 4xx/5xx error page as content.
        "X-Assert-Status-Code": "200",
      }
      if (params.rawHtml) headers["X-Respond-With"] = "html"
      // Drop image markdown from text output to save tokens; raw HTML is returned as-is.
      else headers["X-Retain-Images"] = "none"
      return headers
    },
    body: { url: params.url },
    signal,
    timeout: 15_000,
  })
}
