import { fetchWithTimeout } from "./http"
import type { Extractor } from "./types"

export const jina: Extractor = {
  name: "jina-ai",
  async extract(url) {
    const apiKey = process.env.PI_WEB_FETCH_JINA_API_KEY
    if (!apiKey) return null
    try {
      const res = await fetchWithTimeout(
        "https://r.jina.ai/",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ url }),
        },
        15_000
      )
      if (!res.ok) return null
      const json = await res.json()
      const content = json?.data?.content
      if (typeof content !== "string") return null
      return { markdown: content.trim() }
    } catch {
      return null
    }
  },
}
