import { extractTavily } from "../../providers/tavily"
import type { TavilyExtractResponse } from "../../providers/tavily"
import type { WebExtractItem, WebExtractProviderParams } from "./types"
import { emptyScatter, hasAny, matchResults, scatterErrors, selectPending, urlSet } from "./utils"

function failedUrls(json: any): Set<string> {
  return urlSet(
    Array.isArray(json?.failed_results) ? json.failed_results.map((item: any) => item?.url) : []
  )
}

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

  const output = emptyScatter<WebExtractItem>(urls)
  const matched = matchResults<NonNullable<TavilyExtractResponse["results"]>[number]>(
    selected,
    json?.results,
    (result) => [result?.url],
    failedUrls(json)
  )
  for (const { url, index } of selected) {
    const result = matched.get(index)
    const content = result?.raw_content
    if (typeof content !== "string" || !content.trim()) continue
    // Tavily returns no title. Keep favicon etc. but not a second copy of the content.
    const { raw_content: _content, ...metadata } = result ?? {}
    output[index] = {
      url,
      content: content.trim(),
      source: "tavily",
      metadata,
    }
  }

  scatterErrors(
    output,
    selected,
    (Array.isArray(json?.failed_results) ? json.failed_results : []).map((item) => ({
      url: item?.url,
      message: typeof item?.error === "string" ? item.error : "extraction failed",
    }))
  )
  return hasAny(output) ? output : null
}
