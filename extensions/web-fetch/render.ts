import { Text } from "@mariozechner/pi-tui"

export function renderCall(args: any, theme: any): typeof Text.prototype {
  let text = theme.fg("toolTitle", theme.bold("web_fetch "))
  text += theme.fg("accent", args.url || "...")
  return new Text(text, 0, 0)
}

export function renderResult(result: any, { expanded }: { expanded: boolean }, theme: any): typeof Text.prototype {
  const d = result.details
  const c = result.content?.[0]
  if (d?.error) return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0)

  let text = theme.fg("success", "✓ ")
  if (d?.title) text += theme.fg("toolTitle", d.title) + " "
  const source = c?.source ?? (d?.method === "domain-handler" ? "domain-handler" : d?.stage ?? "?")
  text += theme.fg("muted", `(${source}`)
  if (d?.truncated) text += theme.fg("warning", ", truncated")
  text += theme.fg("muted", `, ${d?.totalLines ?? "?"} lines)`)

  if (c?.metadata && Object.keys(c.metadata).length > 0) {
    const meta = Object.entries(c.metadata)
      .map(([k, v]) => `${k}=${v}`)
      .join(" | ")
    text += "\n" + theme.fg("muted", `  ${meta}`)
  }

  if (d?.fullOutputPath) {
    text += "\n" + theme.fg("muted", `Full output: ${d.fullOutputPath}`)
  }

  if (expanded) {
    if (c?.type === "text") {
      text += "\n\n" + theme.fg("toolOutput", c.text.slice(0, 2000))
      if (c.text.length > 2000) text += theme.fg("muted", "\n... (truncated in preview)")
    }
  }

  return new Text(text, 0, 0)
}
