import { Text } from "@mariozechner/pi-tui"

const PREVIEW_LINES = 5

/** `key=value | key=value`, or undefined when there are no entries. */
export function formatPairs(
  record: Record<string, unknown> | undefined
): string | undefined {
  const entries = Object.entries(record ?? {})
  if (entries.length === 0) return undefined
  return entries.map(([key, value]) => `${key}=${value}`).join(" | ")
}

type Summarize = (
  details: any,
  content: any,
  expanded: boolean,
  theme: any
) => string

/**
 * Build a renderResult with the layout shared by web_fetch and web_extract: an
 * error line, or a success mark, the tool's own summary, the full-output path,
 * and a preview of the text content (a few lines collapsed, all of it expanded).
 */
export function toolResultRenderer(summarize: Summarize) {
  return (
    result: any,
    { expanded }: { expanded: boolean },
    theme: any
  ): typeof Text.prototype =>
    renderToolResult(result, expanded, theme, summarize)
}

function renderToolResult(
  result: any,
  expanded: boolean,
  theme: any,
  summarize: Summarize
): typeof Text.prototype {
  const d = result.details
  const c = result.content?.[0]
  if (d?.error) return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0)

  let text = theme.fg("success", "✓ ") + summarize(d, c, expanded, theme)

  if (d?.fullOutputPath) {
    text += `\n${theme.fg("muted", `Full output: ${d.fullOutputPath}`)}`
  }

  if (c?.type === "text" && c.text) {
    const lines = c.text.split("\n")
    const displayLines = expanded ? lines : lines.slice(0, PREVIEW_LINES)
    const remaining = lines.length - displayLines.length

    if (displayLines.length > 0) {
      text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`
    }

    if (remaining > 0) {
      text += `\n${theme.fg("muted", `... (${remaining} more lines, expand for full)`)}`
    }
  }

  return new Text(text, 0, 0)
}
