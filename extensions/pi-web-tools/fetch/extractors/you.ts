import { fetchWithTimeout } from "./http"
import type { Extractor } from "./types"

export const you: Extractor = {
  name: "you",
  async extract(url, _signal, options) {
    const apiKey = process.env.PI_WEB_FETCH_YOU_API_KEY
    if (!apiKey) return null
    try {
      const formats = options?.rawHtml ? ["html"] : ["markdown"]
      const res = await fetchWithTimeout(
        "https://ydc-index.io/v1/contents",
        {
          method: "POST",
          headers: {
            "X-API-KEY": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            urls: [url],
            formats,
            crawl_timeout: 10,
          }),
        },
        30_000
      )
      if (!res.ok) return null
      const json = await res.json()
      const item = Array.isArray(json) ? json[0] : null

      if (options?.rawHtml) {
        const html = item?.html
        if (typeof html !== "string") return null
        return {
          markdown: "",
          html: html.trim(),
          title: item?.title,
          metadata: item?.title ? { title: item.title } : undefined,
        }
      }

      const markdown = item?.markdown
      if (typeof markdown !== "string") return null
      return {
        markdown: markdown.trim(),
        title: item?.title,
        metadata: item?.title ? { title: item.title } : undefined,
      }
    } catch {
      return null
    }
  },
}
