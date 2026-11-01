import { extractTavily } from "../../providers/tavily"
import type { Extractor } from "./types"

export const tavily: Extractor = {
  name: "tavily",
  async extract(url, signal) {
    const json = await extractTavily(
      { urls: [url], extract_depth: "advanced" },
      signal
    )
    if (!json) return null

    // One URL per request, so any failed result is ours.
    const failed = json?.failed_results
    if (Array.isArray(failed) && failed.length > 0) {
      throw new Error(typeof failed[0]?.error === "string" ? failed[0].error : "extraction failed")
    }

    const content = json?.results?.[0]?.raw_content
    if (typeof content !== "string" || !content.trim()) throw new Error("no content in response")
    const title = json?.results?.[0]?.title
    return {
      markdown: content.trim(),
      metadata: title ? { title } : undefined,
    }
  },
}
