import type { KagiResult, SearchFilters } from "./types"

export function buildSearchArgs(query: string, opts: SearchFilters): string[] {
  const args = ["search", "--format", "compact"]
  if (opts.verbatim) args.push("--verbatim")
  if (opts.region) args.push("--region", opts.region)
  if (opts.time) args.push("--time", opts.time)
  if (opts.fromDate) args.push("--from-date", opts.fromDate)
  if (opts.toDate) args.push("--to-date", opts.toDate)
  if (opts.order) args.push("--order", opts.order)
  args.push(query)
  return args
}

export function formatResults(
  queries: string[],
  resultSets: KagiResult[][]
): string {
  const sections: string[] = []
  let counter = 1

  for (let i = 0; i < queries.length; i++) {
    const results = resultSets[i] ?? []
    const body = results
      .map((r) => {
        const lines = [
          `${counter++}: ${r.title}`,
          r.url,
          `Published: ${r.published ?? "N/A"}`,
          r.snippet ?? "No snippet available",
        ]
        return lines.join("\n")
      })
      .join("\n\n")

    sections.push(`-----\nResults for "${queries[i]}":\n-----\n${body}`)
  }

  return sections.join("\n\n")
}
