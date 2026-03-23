/**
 * Web Search Extension
 *
 * Provides a `web_search` tool that uses the `kagi` CLI to search Kagi.com.
 * Supports multiple parallel queries with structured JSON output.
 *
 * Authentication is handled by the kagi CLI itself:
 *   1. KAGI_SESSION_TOKEN environment variable
 *   2. .kagi.toml config file
 *
 * See: https://kagi.micr.dev/guides/authentication
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface KagiResult {
	t: 0;
	rank: number;
	title: string;
	url: string;
	snippet?: string;
	published?: string | null;
}

interface KagiRelated {
	t: 1;
	list: string[];
}

interface KagiResponse {
	data: Array<KagiResult | KagiRelated>;
}

interface WebSearchDetails {
	queries: string[];
	limit: number;
	resultCount: number;
	urls?: string[];
	error?: string;
}

// ─── CLI helpers ───────────────────────────────────────────────────────────────

/** Build the CLI args for a single `kagi search` invocation. */
function buildSearchArgs(
	query: string,
	opts: {
		verbatim?: boolean;
		region?: string;
		time?: string;
		fromDate?: string;
		toDate?: string;
		order?: string;
	},
): string[] {
	const args = ["search", "--format", "compact"];
	if (opts.verbatim) args.push("--verbatim");
	if (opts.region) args.push("--region", opts.region);
	if (opts.time) args.push("--time", opts.time);
	if (opts.fromDate) args.push("--from-date", opts.fromDate);
	if (opts.toDate) args.push("--to-date", opts.toDate);
	if (opts.order) args.push("--order", opts.order);
	args.push(query);
	return args;
}

// ─── Formatting ────────────────────────────────────────────────────────────────

/**
 * Format search results into numbered text blocks.
 * Results are numbered continuously across all queries.
 */
function formatResults(queries: string[], resultSets: KagiResult[][]): string {
	const sections: string[] = [];
	let counter = 1;

	for (let i = 0; i < queries.length; i++) {
		const results = resultSets[i] ?? [];
		const body = results
			.map((r) => {
				const lines = [
					`${counter++}: ${r.title}`,
					r.url,
					`Published: ${r.published ?? "N/A"}`,
					r.snippet ?? "No snippet available",
				];
				return lines.join("\n");
			})
			.join("\n\n");

		sections.push(`-----\nResults for "${queries[i]}":\n-----\n${body}`);
	}

	return sections.join("\n\n");
}

// ─── Extension ─────────────────────────────────────────────────────────────────

export default function webSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: [
			"Search the web using Kagi.",
			"Accepts one or more queries and runs them in parallel.",
			"Results are numbered continuously across all queries.",
			"Use this when you need current information, facts from the internet, or documentation.",
		].join(" "),
		promptSnippet: "Search the web via Kagi for current information",
		promptGuidelines: [
			"Include essential context within each query so each one is self-contained.",
			"Kagi supports search operators you can embed directly in any query:",
			'  - site:example.com    — restrict to a specific site, e.g. "best router site:reddit.com"',
			'  - filetype:pdf        — filter by file type, e.g. "annual report filetype:pdf"',
			"  - inurl:forum         — URL must contain the term",
			"  - intitle:guide       — page title must contain the term",
			'  - "exact phrase"      — match the exact phrase',
			'  - -term               — exclude a term, e.g. "jaguar speed -car"',
			'  - term1 OR term2      — either term, e.g. "recipes (szechuan OR cantonese)"',
			"  - term1 AND term2     — both terms",
			'  - *                   — wildcard, e.g. "best * ever"',
			"Use the verbatim parameter when you need results containing the query string exactly as typed.",
			"Use region to restrict results geographically (e.g. 'us', 'gb', 'jp').",
			"Use time or fromDate/toDate to restrict results by recency.",
			"Use order: 'recency' to sort by most recent first.",
		],
		parameters: Type.Object({
			queries: Type.Array(
				Type.String({
					description:
						"A search query. Kagi search operators (site:, filetype:, inurl:, intitle:, \"exact phrase\", -exclude, OR, AND) can be embedded directly.",
				}),
				{
					description:
						"One or more search queries to run in parallel. Include essential context within each query for standalone use.",
					minItems: 1,
				},
			),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of results per query (default: 10, max: 50)",
					minimum: 1,
					maximum: 50,
				}),
			),
			verbatim: Type.Optional(
				Type.Boolean({
					description:
						"When true, enables Kagi's verbatim search mode — matches the exact query as typed. " +
						"Useful for specific strings, error messages, or exact titles.",
				}),
			),
			region: Type.Optional(
				Type.String({
					description:
						"Restrict results to a Kagi region code (e.g. 'us', 'gb', 'jp', 'de'). Use 'no_region' to disable geographic filtering.",
				}),
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
					},
				),
			),
			fromDate: Type.Optional(
				Type.String({
					description:
						"Restrict results to pages updated on or after this date (YYYY-MM-DD). Cannot be combined with time.",
				}),
			),
			toDate: Type.Optional(
				Type.String({
					description:
						"Restrict results to pages updated on or before this date (YYYY-MM-DD). Cannot be combined with time.",
				}),
			),
			order: Type.Optional(
				Type.Union(
					[
						Type.Literal("default"),
						Type.Literal("recency"),
						Type.Literal("website"),
						Type.Literal("trackers"),
					],
					{ description: "Reorder search results. Use 'recency' for most recent first." },
				),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const { queries, limit = 10, verbatim, region, time, fromDate, toDate, order } = params;

			const filterOpts = { verbatim, region, time, fromDate, toDate, order };

			// Run all queries in parallel
			const TIMEOUT_MS = 15_000;
			const settled = await Promise.allSettled(
				queries.map((q) =>
					pi.exec("kagi", buildSearchArgs(q, filterOpts), {
						signal,
						timeout: TIMEOUT_MS,
					}),
				),
			);

			// Check for cancellation
			if (signal?.aborted) {
				return {
					content: [{ type: "text" as const, text: "Search was cancelled." }],
					details: { queries, limit, resultCount: 0, error: "cancelled" } as WebSearchDetails,
					isError: true,
				};
			}

			// Parse results
			const resultSets: KagiResult[][] = [];
			const errors: string[] = [];

			for (let i = 0; i < settled.length; i++) {
				const s = settled[i];
				if (s.status === "rejected") {
					errors.push(`Query "${queries[i]}": ${s.reason?.message ?? String(s.reason)}`);
					resultSets.push([]);
					continue;
				}

				const { stdout, stderr, code } = s.value;
				if (code !== 0) {
					errors.push(`Query "${queries[i]}": ${stderr.trim() || `exit code ${code}`}`);
					resultSets.push([]);
					continue;
				}

				try {
					const response = JSON.parse(stdout) as KagiResponse;
					const results = (response.data ?? []).filter((item): item is KagiResult => item.t === 0);
					resultSets.push(results.slice(0, limit));
				} catch (e: any) {
					errors.push(`Query "${queries[i]}": failed to parse response — ${e.message}`);
					resultSets.push([]);
				}
			}

			const totalCount = resultSets.reduce((sum, r) => sum + r.length, 0);
			const allUrls = resultSets.flatMap((r) => r.map((item) => item.url));

			if (totalCount === 0 && errors.length === 0) {
				return {
					content: [{ type: "text" as const, text: `No results found for: ${queries.join(", ")}` }],
					details: { queries, limit, resultCount: 0 } as WebSearchDetails,
				};
			}

			let text = formatResults(queries, resultSets);
			if (errors.length > 0) {
				text += "\n\nErrors:\n" + errors.join("\n");
			}

			return {
				content: [{ type: "text" as const, text }],
				details: { queries, limit, resultCount: totalCount, urls: allUrls } as WebSearchDetails,
			};
		},

		renderCall(args, theme) {
			const qs = (args.queries ?? []).map((q: string) => `"${q}"`).join(", ");
			let text = theme.fg("toolTitle", theme.bold("web_search "));
			text += theme.fg("accent", qs || "...");
			const tags: string[] = [];
			if (args.verbatim) tags.push("verbatim");
			if (args.region) tags.push(`region:${args.region}`);
			if (args.time) tags.push(`time:${args.time}`);
			if (args.fromDate || args.toDate) tags.push(`${args.fromDate ?? "…"}→${args.toDate ?? "…"}`);
			if (args.order && args.order !== "default") tags.push(`order:${args.order}`);
			if (args.limit) tags.push(`limit:${args.limit}`);
			if (tags.length > 0) {
				text += " " + theme.fg("dim", tags.join(" "));
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as WebSearchDetails | undefined;

			if (details?.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}

			let text = theme.fg("success", "✓ ");
			text += theme.fg("muted", `${details?.resultCount ?? "?"} results`);
			if ((details?.queries?.length ?? 0) > 1) {
				text += theme.fg("dim", ` across ${details!.queries.length} queries`);
			}

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					text += "\n\n" + theme.fg("toolOutput", content.text);
				}
			} else if (details?.urls?.length) {
				text += "\n  " + theme.fg("dim", details.urls.slice(0, 3).join("\n  "));
				if (details.urls.length > 3) {
					text += theme.fg("muted", `\n  ... +${details.urls.length - 3} more`);
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
