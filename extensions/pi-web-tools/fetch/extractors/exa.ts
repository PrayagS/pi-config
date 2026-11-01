import { exaStatusError, getExaContents } from "../../providers/exa"
import type { Extractor } from "./types"

export const exa: Extractor = {
  name: "exa",
  async extract(url, signal) {
    const json = await getExaContents(
      { ids: [url], text: { verbosity: "full" } },
      signal
    )
    if (!json) return null

    // One URL per request, so any non-success status is ours.
    const failed = Array.isArray(json?.statuses)
      ? json.statuses.find((s: any) => s?.status !== "success")
      : undefined
    if (failed) throw new Error(exaStatusError(failed))

    const result = json?.results?.[0]
    const text = result?.text
    if (typeof text !== "string" || !text.trim()) throw new Error("no text in response")
    return {
      markdown: text.trim(),
      title: result?.title,
      metadata: result?.title ? { title: result.title } : undefined,
    }
  },
}
