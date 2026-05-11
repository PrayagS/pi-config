import { Text } from "@mariozechner/pi-tui"
import type { WebSearchDetails } from "./types"

export function renderCall(args: any, theme: any): typeof Text.prototype {
  const qs = (args.queries ?? []).map((q: string) => `"${q}"`).join(", ")
  let text = theme.fg("toolTitle", theme.bold("web_search "))
  text += theme.fg("accent", qs || "...")

  const tags: string[] = []
  if (args.verbatim) tags.push("verbatim")
  if (args.region) tags.push(`region:${args.region}`)
  if (args.time) tags.push(`time:${args.time}`)
  if (args.fromDate || args.toDate)
    tags.push(`${args.fromDate ?? "…"}→${args.toDate ?? "…"}`)
  if (args.order && args.order !== "default") tags.push(`order:${args.order}`)
  if (args.limit) tags.push(`limit:${args.limit}`)
  if (tags.length > 0) text += " " + theme.fg("dim", tags.join(" "))

  return new Text(text, 0, 0)
}

export function renderResult(
  result: any,
  { expanded }: { expanded: boolean },
  theme: any
): typeof Text.prototype {
  const details = result.details as WebSearchDetails | undefined

  if (details?.error) {
    return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0)
  }

  let text = theme.fg("success", "✓ ")
  text += theme.fg("muted", `${details?.resultCount ?? "?"} results`)
  if ((details?.queries?.length ?? 0) > 1) {
    text += theme.fg("dim", ` across ${details!.queries.length} queries`)
  }

  if (expanded) {
    const content = result.content[0]
    if (content?.type === "text") {
      text += "\n\n" + theme.fg("toolOutput", content.text)
    }
  } else if (details?.urls?.length) {
    text += "\n  " + theme.fg("dim", details.urls.slice(0, 3).join("\n  "))
    if (details.urls.length > 3) {
      text += theme.fg("muted", `\n  ... +${details.urls.length - 3} more`)
    }
  }

  return new Text(text, 0, 0)
}
