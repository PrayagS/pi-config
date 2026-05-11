import { fetchWithTimeout } from "./http"
import type { Extractor } from "./types"

export const exa: Extractor = {
  name: "exa",
  async extract(url) {
    const apiKey = process.env.PI_WEB_FETCH_EXA_API_KEY
    if (!apiKey) return null
    try {
      const res = await fetchWithTimeout(
        "https://api.exa.ai/contents",
        {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ids: [url], text: { verbosity: "full" } }),
        },
        30_000
      )
      if (!res.ok) return null
      const json = await res.json()
      const result = json?.results?.[0]
      const text = result?.text
      if (typeof text !== "string") return null
      return { markdown: text.trim(), title: result?.title }
    } catch {
      return null
    }
  },
}
