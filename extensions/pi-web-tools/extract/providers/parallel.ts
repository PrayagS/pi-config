import { extractParallel, parallelError } from "../../providers/parallel"
import type { WebExtractItem, WebExtractProviderParams } from "./types"
import { emptyScatter, hasAny, matchResults, scatterErrors, selectPending, urlSet } from "./utils"

function failedUrls(json: any): Set<string> {
  return urlSet(Array.isArray(json?.errors) ? json.errors.map((error: any) => error?.url) : [])
}

export async function extractParallelTargeted({
  urls,
  mode,
  prompt,
  pending,
  signal,
  sessionKey,
}: WebExtractProviderParams): Promise<Array<WebExtractItem | null> | null> {
  if (mode !== "targeted") return null

  const selected = selectPending(urls, pending)
  if (selected.length === 0) return null

  const json = await extractParallel(
    { urls: selected.map(({ url }) => url), objective: prompt },
    signal,
    sessionKey
  )
  if (!json) return null

  const output = emptyScatter<WebExtractItem>(urls)
  const matched = matchResults<any>(
    selected,
    json?.results,
    (result) => [result?.url],
    failedUrls(json)
  )
  for (const { url, index } of selected) {
    const result = matched.get(index)
    const excerpts = result?.excerpts
    if (!Array.isArray(excerpts) || excerpts.length === 0) continue
    const clean = excerpts.filter((excerpt: unknown): excerpt is string =>
      typeof excerpt === "string" && excerpt.trim().length > 0
    )
    if (clean.length === 0) continue
    output[index] = {
      url,
      title: result?.title,
      excerpts: clean.map((excerpt) => excerpt.trim()),
      source: "parallel",
      metadata: result,
    }
  }

  scatterErrors(
    output,
    selected,
    (Array.isArray(json?.errors) ? json.errors : []).map((error: any) => ({
      url: error?.url,
      message: parallelError(error),
    }))
  )
  return hasAny(output) ? output : null
}
