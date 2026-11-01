import { extractParallel, parallelError } from "../../providers/parallel"
import type { Extractor } from "./types"

export const parallel: Extractor = {
  name: "parallel",
  async extract(url, signal, options) {
    const json = await extractParallel(
      {
        urls: [url],
        advanced_settings: { full_content: true },
      },
      signal,
      options?.sessionKey
    )
    if (!json) return null

    // One URL per request, so any error is ours.
    if (Array.isArray(json?.errors) && json.errors.length > 0) {
      throw new Error(parallelError(json.errors[0]))
    }

    const result = json?.results?.[0]
    const excerpts = Array.isArray(result?.excerpts)
      ? result.excerpts.filter((e: unknown) => typeof e === "string" && e.trim())
      : []
    const markdown =
      typeof result?.full_content === "string" && result.full_content.trim()
        ? result.full_content
        : excerpts.length > 0
          ? // Don't present excerpts as the full page.
            `> Parallel returned excerpts only; the full page content was unavailable.\n\n${excerpts.join("\n\n")}`
          : undefined
    if (!markdown) throw new Error("no content in response")
    const metadata: Record<string, unknown> = {}
    if (result?.title) metadata.title = result.title
    return {
      markdown: markdown.trim(),
      title: result?.title,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    }
  },
}
