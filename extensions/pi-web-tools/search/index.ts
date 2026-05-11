import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { buildSearchArgs, formatResults } from "./kagi"
import { renderCall, renderResult } from "./render"
import type { KagiResponse, KagiResult, WebSearchDetails } from "./types"

const TIMEOUT_MS = 15_000

export function createWebSearchTool(pi: ExtensionAPI) {
  return {
    name: "web_search" as const,
    label: "Web Search",
    description:
      'Search the web using Kagi. Accepts one or more queries and runs them in parallel. Results are numbered continuously across all queries. Use this when you need current information, facts from the internet, or documentation. Include essential context within each query so each one is self-contained. Kagi supports search operators embedded directly in the query string: site:example.com (restrict to a site), filetype:pdf (filter by file type), inurl:term (URL must contain term), intitle:term (title must contain term), "exact phrase" (exact match), -term (exclude), OR / AND (boolean), * (wildcard).',
    parameters: Type.Object({
      queries: Type.Array(
        Type.String({
          description:
            'A search query. Kagi search operators (site:, filetype:, inurl:, intitle:, "exact phrase", -exclude, OR, AND) can be embedded directly.',
        }),
        {
          description:
            "One or more search queries to run in parallel. Include essential context within each query for standalone use.",
          minItems: 1,
        }
      ),
      limit: Type.Optional(
        Type.Number({
          description:
            "Maximum number of results per query (default: 10, max: 50)",
          minimum: 1,
          maximum: 50,
        })
      ),
      verbatim: Type.Optional(
        Type.Boolean({
          description:
            "When true, enables Kagi's verbatim search mode — matches the exact query as typed. Useful for specific strings, error messages, or exact titles.",
        })
      ),
      region: Type.Optional(
        Type.String({
          description:
            "Restrict results to a Kagi region code (e.g. 'us', 'gb', 'jp', 'de'). Use 'no_region' to disable geographic filtering.",
        })
      ),
      time: Type.Optional(
        Type.Union(
          [
            Type.Literal("day"),
            Type.Literal("week"),
            Type.Literal("month"),
            Type.Literal("year"),
          ],
          {
            description:
              "Restrict results to a recent time window. Cannot be combined with fromDate/toDate.",
          }
        )
      ),
      fromDate: Type.Optional(
        Type.String({
          description:
            "Restrict results to pages updated on or after this date (YYYY-MM-DD). Cannot be combined with time.",
        })
      ),
      toDate: Type.Optional(
        Type.String({
          description:
            "Restrict results to pages updated on or before this date (YYYY-MM-DD). Cannot be combined with time.",
        })
      ),
      order: Type.Optional(
        Type.Union(
          [
            Type.Literal("default"),
            Type.Literal("recency"),
            Type.Literal("website"),
            Type.Literal("trackers"),
          ],
          {
            description:
              "Reorder search results. Use 'recency' for most recent first.",
          }
        )
      ),
    }),

    async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
      const {
        queries,
        limit = 10,
        verbatim,
        region,
        time,
        fromDate,
        toDate,
        order,
      } = params

      const filterOpts = { verbatim, region, time, fromDate, toDate, order }
      const settled = await Promise.allSettled(
        queries.map((q: string) =>
          pi.exec("kagi", buildSearchArgs(q, filterOpts), {
            signal,
            timeout: TIMEOUT_MS,
          })
        )
      )

      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "Search was cancelled." }],
          details: {
            queries,
            limit,
            resultCount: 0,
            error: "cancelled",
          } as WebSearchDetails,
          isError: true,
        }
      }

      const resultSets: KagiResult[][] = []
      const errors: string[] = []

      for (let i = 0; i < settled.length; i++) {
        const s = settled[i]
        if (s.status === "rejected") {
          errors.push(
            `Query "${queries[i]}": ${s.reason?.message ?? String(s.reason)}`
          )
          resultSets.push([])
          continue
        }

        const { stdout, stderr, code } = s.value
        if (code !== 0) {
          errors.push(
            `Query "${queries[i]}": ${stderr.trim() || `exit code ${code}`}`
          )
          resultSets.push([])
          continue
        }

        try {
          const response = JSON.parse(stdout) as KagiResponse
          const results = (response.data ?? []).filter(
            (item): item is KagiResult => item.t === 0
          )
          resultSets.push(results.slice(0, limit))
        } catch (e: any) {
          errors.push(
            `Query "${queries[i]}": failed to parse response — ${e.message}`
          )
          resultSets.push([])
        }
      }

      const totalCount = resultSets.reduce((sum, r) => sum + r.length, 0)
      const allUrls = resultSets.flatMap((r) => r.map((item) => item.url))

      if (totalCount === 0 && errors.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No results found for: ${queries.join(", ")}`,
            },
          ],
          details: { queries, limit, resultCount: 0 } as WebSearchDetails,
        }
      }

      let text = formatResults(queries, resultSets)
      if (errors.length > 0) text += "\n\nErrors:\n" + errors.join("\n")

      return {
        content: [{ type: "text" as const, text }],
        details: {
          queries,
          limit,
          resultCount: totalCount,
          urls: allUrls,
        } as WebSearchDetails,
      }
    },

    renderCall,
    renderResult,
  }
}
