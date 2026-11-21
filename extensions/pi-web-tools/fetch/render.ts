import { Text } from "@mariozechner/pi-tui"
import { formatPairs, toolResultRenderer } from "../render"

export function renderCall(args: any, theme: any): typeof Text.prototype {
  let text = theme.fg("toolTitle", theme.bold("web_fetch"))
  text += ` ${theme.fg("accent", args.url || "...")}`
  if (args.rawHtml) {
    text += ` ${theme.fg("muted", "rawHtml")}`
  }
  return new Text(text, 0, 0)
}

export const renderResult = toolResultRenderer((d, c, expanded, theme) => {
  let text = d?.title ? `${theme.fg("toolTitle", d.title)} ` : ""
  const source =
    c?.source ??
    (d?.method === "domain-handler" ? "domain-handler" : (d?.stage ?? "?"))
  text += theme.fg("muted", `(${source}`)
  if (d?.truncated) text += theme.fg("warning", ", truncated")
  text += theme.fg("muted", `, ${d?.totalLines ?? "?"} lines)`)

  const meta = formatPairs(c?.metadata)
  if (meta) text += `\n${theme.fg("muted", `  ${meta}`)}`

  if (Array.isArray(d?.providerErrors) && d.providerErrors.length > 0) {
    text += `\n${theme.fg("warning", `  \u26a0 ${d.providerErrors.length} provider(s) failed before ${source}`)}`
    if (expanded) {
      text += `\n${theme.fg("dim", d.providerErrors.map((e: string) => `  ${e}`).join("\n"))}`
    }
  }
  return text
})
