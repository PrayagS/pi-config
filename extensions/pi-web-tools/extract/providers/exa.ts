import { exaStatusError, getExaContents } from "../../providers/exa"
import type { WebExtractItem, WebExtractProviderParams } from "./types"
import { scatterBatch, selectPending } from "./utils"

function failedStatuses(json: any): any[] {
  const statuses = Array.isArray(json?.statuses) ? json.statuses : []
  return statuses.filter((s: any) => s?.status !== "success")
}

export async function extractExa({
  urls,
  mode,
  prompt,
  pending,
  signal,
}: WebExtractProviderParams): Promise<Array<WebExtractItem | null> | null> {
  const selected = selectPending(urls, pending)
  if (selected.length === 0) return null

  const summary = mode === "targeted" ? { query: prompt } : true
  const json = await getExaContents(
    { urls: selected.map(({ url }) => url), summary, text: false },
    signal
  )
  if (!json) return null

  return scatterBatch<any>(
    urls,
    selected,
    {
      results: json?.results,
      resultUrls: (result) => [result?.id, result?.url],
      failures: failedStatuses(json).map((s) => ({ url: s?.id, message: exaStatusError(s) })),
    },
    (url, result) => {
      const content = result?.summary
      if (typeof content !== "string" || !content.trim()) return null
      return {
        url,
        title: result?.title,
        content: content.trim(),
        source: "exa",
        metadata: result,
      }
    }
  )
}
