import type { SearchFilters } from "../search/types"

export function buildKagiSearchArgs(
  query: string,
  opts: SearchFilters
): string[] {
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
