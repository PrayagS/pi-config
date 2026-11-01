import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import TurndownService from "turndown"
import type { WebExtractItem, WebExtractProviderParams } from "./types"
import { emptyScatter, hasAny, selectPending } from "./utils"

const TIMEOUT_MS = 30_000

/** `kagi summarize --subscriber` JSON (kagi-cli SubscriberSummarization). No title or url. */
interface KagiResponse {
  data?: {
    thread_id?: unknown
    state?: unknown
    /** Despite the name, the subscriber summarizer returns HTML here. */
    markdown?: unknown
  }
}

let turndown: TurndownService | undefined

/**
 * Convert the summary to Markdown and split off the "Title: ..." line the
 * summarizer puts first.
 */
export function parseKagiSummary(value: unknown): { title?: string; content: string } | null {
  if (typeof value !== "string" || !value.trim()) return null
  let content = value.trim()
  if (content.startsWith("<")) {
    turndown ??= new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" })
    content = turndown.turndown(content).trim()
  }
  const match = content.match(/^(?:\*\*)?Title:(?:\*\*)?\s*(.+?)\s*(?:\n+|$)/)
  if (!match) return content ? { content } : null
  const rest = content.slice(match[0].length).trim()
  return rest ? { title: match[1], content: rest } : { content }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** With --error-format json, kagi-cli writes {code, category, retryable, message} to stderr. */
export function cliError(stderr: string, code: number) {
  let message = stderr.trim()
  try {
    const parsed = JSON.parse(message)
    if (typeof parsed?.message === "string") {
      message = typeof parsed.code === "string" ? `${parsed.code}: ${parsed.message}` : parsed.message
    }
  } catch {
    // Plain-text error (older CLI or a crash before JSON output).
  }
  message = message.replace(/\s+/g, " ").slice(0, 300)
  return message ? `kagi exited ${code}: ${message}` : `kagi exited ${code}`
}

export function createKagiSummaryExtractor(pi: ExtensionAPI) {
  return async function extractKagiSummary({
    urls,
    mode,
    pending,
    signal,
  }: WebExtractProviderParams): Promise<Array<WebExtractItem | null> | null> {
    if (mode !== "summary") return null

    const selected = selectPending(urls, pending)
    if (selected.length === 0) return null

    const settled = await Promise.allSettled(
      selected.map(({ url }) =>
        pi.exec(
          "kagi",
          [
            "summarize",
            "--error-format",
            "json",
            "--subscriber",
            "--length",
            "long",
            "--summary-type",
            "keypoints",
            "--url",
            url,
          ],
          { signal, timeout: TIMEOUT_MS }
        )
      )
    )

    const output = emptyScatter<WebExtractItem>(urls)
    for (const [selectedIndex, result] of settled.entries()) {
      const { url, index } = selected[selectedIndex]
      if (result.status === "rejected") {
        output[index] = { url, error: errorText(result.reason) }
        continue
      }

      const { stdout, stderr, code } = result.value
      if (code !== 0) {
        output[index] = { url, error: cliError(stderr, code) }
        continue
      }

      try {
        const response = JSON.parse(stdout) as KagiResponse
        const summary = parseKagiSummary(response.data?.markdown)
        if (!summary) {
          output[index] = { url, error: "empty summary" }
          continue
        }

        // Keep the thread id, not the full payload (prompt, documents, metadata_html).
        const threadId = response.data?.thread_id
        output[index] = {
          url,
          title: summary.title,
          content: summary.content,
          source: "kagi",
          metadata: typeof threadId === "string" && threadId ? { thread_id: threadId } : undefined,
        }
      } catch {
        output[index] = { url, error: "invalid JSON from kagi CLI" }
      }
    }

    return hasAny(output) ? output : null
  }
}
