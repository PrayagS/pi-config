import { extractTavily } from "../../providers/tavily"
import type { TavilyExtractResponse } from "../../providers/tavily"
import type { WebExtractItem, WebExtractProviderParams } from "./types"
import { scatterBatch, selectPending } from "./utils"

export async function extractTavilyTargeted({
  urls,
  mode,
  prompt,
  pending,
  signal,
}: WebExtractProviderParams): Promise<Array<WebExtractItem | null> | null> {
  if (mode !== "targeted") return null

  const selected = selectPending(urls, pending)
  if (selected.length === 0) return null

  const json = await extractTavily(
    {
      urls: selected.map(({ url }) => url),
      query: prompt,
      chunks_per_source: 5,
      extract_depth: "advanced",
      format: "markdown",
    },
    signal
  )
  if (!json) return null

  return scatterBatch<NonNullable<TavilyExtractResponse["results"]>[number]>(
    urls,
    selected,
    {
      results: json?.results,
      resultUrls: (result) => [result?.url],
      failures: (Array.isArray(json?.failed_results) ? json.failed_results : []).map((item) => ({
        url: item?.url,
        message: typeof item?.error === "string" ? item.error : "extraction failed",
      })),
    },
    (url, result) => {
      const content = result?.raw_content
      if (typeof content !== "string" || !content.trim()) return null
      // Tavily returns no title. Keep favicon etc. but not a second copy of the content.
      const { raw_content: _content, ...metadata } = result ?? {}
      return {
        url,
        content: content.trim(),
        source: "tavily",
        metadata,
      }
    }
  )
}
