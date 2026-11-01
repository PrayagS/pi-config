import { ageCutoffDate } from "../search/age"
import type { SearchFilters } from "../search/types"

export function buildKagiSearchArgs(
  query: string,
  opts: SearchFilters,
  limit?: number
): string[] {
  const args = ["search", "--format", "compact"]
  if (limit) args.push("--limit", String(limit))
  // --time is session-auth only in kagi-cli; --from-date works with session and API-key auth.
  const fromDate = ageCutoffDate(opts.age)
  if (fromDate) args.push("--from-date", fromDate)
  const domainTerms = [
    ...(opts.includeDomains ?? []).map((domain) => `site:${domain}`),
    ...(opts.excludeDomains ?? []).map((domain) => `-site:${domain}`),
  ]
  args.push([...domainTerms, query].join(" "))
  return args
}
