import { HttpError, fetchWithTimeout } from "../../providers/http"
import type { Extractor } from "./types"

export const markdownNew: Extractor = {
  name: "markdown-new",
  async extract(url, signal) {
    const res = await fetchWithTimeout(`https://markdown.new/${url}`, { signal, timeout: 15_000 })
    if (!res.ok) throw new HttpError(res.status, "")
    const trimmed = (await res.text()).trim()
    if (!trimmed) throw new Error("empty response")
    return { markdown: trimmed }
  },
}
