import { exaStatusError, getExaContents } from "../../providers/exa"
import type { WebExtractItem, WebExtractProviderParams } from "./types"
import { emptyScatter, hasAny, matchResults, scatterErrors, selectPending, urlSet } from "./utils"

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

  const output = emptyScatter<WebExtractItem>(urls)
  const matched = matchResults<any>(
    selected,
    json?.results,
    (result) => [result?.id, result?.url],
    urlSet(failedStatuses(json).map((s) => s?.id))
  )
  for (const { url, index } of selected) {
    const result = matched.get(index)
    const content = result?.summary
    if (typeof content !== "string" || !content.trim()) continue
    output[index] = {
      url,
      title: result?.title,
      content: content.trim(),
      source: "exa",
      metadata: result,
    }
  }

  scatterErrors(
    output,
    selected,
    failedStatuses(json).map((s) => ({ url: s?.id, message: exaStatusError(s) }))
  )
  return hasAny(output) ? output : null
}
