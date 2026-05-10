import { Text } from "@mariozechner/pi-tui"

export function renderCall(args: any, theme: any): typeof Text.prototype {
  let text = theme.fg("toolTitle", theme.bold("fetch_url "))
  text += theme.fg("accent", args.url || "...")
  return new Text(text, 0, 0)
}

export function renderResult(result: any, { expanded }: { expanded: boolean }, theme: any): typeof Text.prototype {
  const d = result.details
  if (d?.error) return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0)

  let text = theme.fg("success", "✓ ")
  if (d?.title) text += theme.fg("toolTitle", d.title) + " "
  text += theme.fg("muted", d?.method === "domain-handler" ? "(domain handler" : `(${d?.stage ?? "?"}`)
  if (d?.truncated) text += theme.fg("warning", ", truncated")
  text += theme.fg("muted", `, ${d?.totalLines ?? "?"} lines)`)

  if (d?.fullOutputPath) {
    text += "\n" + theme.fg("muted", `Full output: ${d.fullOutputPath}`)
  }

  if (expanded) {
    const content = result.content[0]
    if (content?.type === "text") {
      text += "\n\n" + theme.fg("toolOutput", content.text.slice(0, 2000))
      if (content.text.length > 2000) text += theme.fg("muted", "\n... (truncated in preview)")
    }
  }

  return new Text(text, 0, 0)
}
