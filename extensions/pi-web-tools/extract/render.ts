import { Text } from "@mariozechner/pi-tui"
import { formatPairs, toolResultRenderer } from "../render"

function previewPrompt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const oneLine = value.trim().replace(/\s+/g, " ")
  if (!oneLine) return undefined
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine
}

export function renderCall(args: any, theme: any): typeof Text.prototype {
  let text = theme.fg("toolTitle", theme.bold("web_extract"))
  const urls = Array.isArray(args.urls) ? args.urls : []
  text += ` ${theme.fg("accent", `${urls.length || "?"} url${urls.length === 1 ? "" : "s"}`)}`
  if (args.mode) text += ` ${theme.fg("muted", args.mode)}`

  const prompt = args.mode === "targeted" ? previewPrompt(args.prompt) : undefined
  if (prompt) text += ` ${theme.fg("muted", "prompt:")} ${theme.fg("toolOutput", prompt)}`

  return new Text(text, 0, 0)
}

export const renderResult = toolResultRenderer((d, _c, _expanded, theme) => {
  let text = theme.fg("toolTitle", `web_extract ${d?.mode ?? ""}`)
  text += theme.fg(
    "muted",
    ` (${d?.successCount ?? 0}/${d?.urlCount ?? "?"} URLs`
  )
  if (d?.truncated) text += theme.fg("warning", ", truncated")
  text += theme.fg("muted", ")")

  const sources = formatPairs(d?.sources)
  if (sources) text += `\n${theme.fg("muted", `  ${sources}`)}`
  return text
})
