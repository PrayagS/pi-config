import { extractParallel, parallelError } from "../../providers/parallel"
import type { WebExtractItem, WebExtractProviderParams } from "./types"
import { scatterBatch, selectPending } from "./utils"

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

  return scatterBatch<any>(
    urls,
    selected,
    {
      results: json?.results,
      resultUrls: (result) => [result?.url],
      failures: (Array.isArray(json?.errors) ? json.errors : []).map((error: any) => ({
        url: error?.url,
        message: parallelError(error),
      })),
    },
    (url, result) => {
      const excerpts = result?.excerpts
      if (!Array.isArray(excerpts)) return null
      const clean = excerpts.filter((excerpt: unknown): excerpt is string =>
        typeof excerpt === "string" && excerpt.trim().length > 0
      )
      if (clean.length === 0) return null
      return {
        url,
        title: result?.title,
        excerpts: clean.map((excerpt) => excerpt.trim()),
        source: "parallel",
        metadata: result,
      }
    }
  )
}
