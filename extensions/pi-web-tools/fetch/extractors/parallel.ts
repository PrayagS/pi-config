import { fetchWithTimeout } from "./http"
import type { Extractor } from "./types"

let sessionId: string | undefined

export const parallel: Extractor = {
  name: "parallel",
  async extract(url) {
    const apiKey = process.env.PI_WEB_FETCH_PARALLEL_API_KEY
    if (!apiKey) return null
    try {
      const body: Record<string, unknown> = {
        urls: [url],
        advanced_settings: { full_content: true },
      }
      if (sessionId) body.session_id = sessionId

      const res = await fetchWithTimeout(
        "https://api.parallel.ai/v1/extract",
        {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        30_000
      )
      if (!res.ok) return null
      const json = await res.json()

      // Store session_id for subsequent calls
      if (json?.session_id) sessionId = json.session_id

      // Treat non-empty errors array as failure
      if (json?.errors && Array.isArray(json.errors) && json.errors.length > 0) {
        return null
      }

      const result = json?.results?.[0]
      const markdown =
        result?.full_content ||
        (Array.isArray(result?.excerpts) ? result.excerpts.join("\n\n") : null)
      if (typeof markdown !== "string") return null
      const metadata: Record<string, unknown> = {}
      if (result?.title) metadata.title = result.title
      return {
        markdown: markdown.trim(),
        title: result?.title,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      }
    } catch {
      return null
    }
  },
}
