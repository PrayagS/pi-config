import { HttpError, fetchWithTimeout } from "../../providers/http"
import type { Extractor } from "./types"

export const markdownNew: Extractor = {
  name: "markdown-new",
  async extract(url, signal) {
    // POST keeps the target URL's own query string from being read as
    // markdown.new options (method, retain_images), as it would be in GET /<url>.
    const res = await fetchWithTimeout("https://markdown.new/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url }),
      signal,
      timeout: 15_000,
    })
    if (!res.ok) throw new HttpError(res.status, "")
    const json: any = await res.json()
    if (json?.success === false) {
      throw new Error(typeof json?.error === "string" ? json.error : "conversion failed")
    }
    const content = typeof json?.content === "string" ? json.content.trim() : ""
    if (!content) throw new Error("empty response")
    return { markdown: content }
  },
}
