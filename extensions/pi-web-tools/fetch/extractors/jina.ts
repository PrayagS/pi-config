import { fetchWithTimeout } from "./http"
import type { Extractor } from "./types"

export const jina: Extractor = {
  name: "jina-ai",
  async extract(url, signal, options) {
    const apiKey = process.env.PI_WEB_FETCH_JINA_API_KEY
    if (!apiKey) return null
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      }
      if (options?.rawHtml) headers["X-Respond-With"] = "html"

      const res = await fetchWithTimeout(
        "https://r.jina.ai/",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ url }),
          signal,
          timeout: 15_000,
        }
      )
      if (!res.ok) return null
      const json = await res.json()

      if (options?.rawHtml) {
        const html = json?.data?.html || json?.data?.content
        if (typeof html !== "string") return null
        return { markdown: "", html: html.trim() }
      }

      const content = json?.data?.content
      if (typeof content !== "string") return null
      const title = json?.data?.title
      return {
        markdown: content.trim(),
        metadata: title ? { title } : undefined,
      }
    } catch {
      return null
    }
  },
}
