/**
 * Web Search Extension
 *
 * Provides a `web_search` tool that uses the kagi-ken package natively
 * to search Kagi.com. Supports multiple parallel queries.
 *
 * Authentication (in priority order):
 *   1. KAGI_SESSION_TOKEN environment variable
 *   2. ~/.kagi_session_token file
 *
 * Get your token: https://kagi.com/settings/user_details
 * → Session Link → copy to clipboard → extract the "token" parameter.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { search } from "kagi-ken";

// ─── Token resolution ──────────────────────────────────────────────────────────

function resolveToken(): string {
	const envToken = process.env.KAGI_SESSION_TOKEN?.trim();
	if (envToken) return envToken;

	try {
		const token = readFileSync(join(homedir(), ".kagi_session_token"), "utf8").trim();
		if (token) return token;
	} catch (err: any) {
		if (err.code !== "ENOENT") throw new Error(`Failed to read ~/.kagi_session_token: ${err.message}`);
	}

	throw new Error(
		"No Kagi session token found. Either set the KAGI_SESSION_TOKEN environment variable " +
		"or save your token to ~/.kagi_session_token.\n" +
		"Get your token: https://kagi.com/settings/user_details → Session Link",
	);
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface KagiResult {
	t: 0;
	url: string;
	title: string;
	snippet?: string;
	published?: string;
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

// ─── Formatting ────────────────────────────────────────────────────────────────

/**
 * Mirrors the official Kagi MCP format from kagi-ken-mcp:
 * - Results numbered continuously across all queries
 * - Per-query sections delimited by `-----`
 */
function formatResults(queries: string[], responses: KagiResponse[]): string {
	const sections: string[] = [];
	let counter = 1;

	for (let i = 0; i < queries.length; i++) {
		const results = (responses[i]?.data ?? []).filter((item): item is KagiResult => item.t === 0);

		const body = results
			.map((r) => {
				const lines = [
					`${counter++}: ${r.title}`,
					r.url,
					`Published Date: ${r.published ?? "Not Available"}`,
					r.snippet ?? "No snippet available",
				];
				return lines.join("\n");
			})
			.join("\n\n");

		sections.push(`-----\nResults for search query "${queries[i]}":\n-----\n${body}`);
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
			"  - site:example.com    — restrict to a specific site, e.g. \"best router site:reddit.com\"",
			"  - filetype:pdf        — filter by file type, e.g. \"annual report filetype:pdf\"",
			"  - inurl:forum         — URL must contain the term",
			"  - intitle:guide       — page title must contain the term",
			"  - \"exact phrase\"      — match the exact phrase, e.g. \"survival is insufficient\"",
			"  - -term               — exclude a term, e.g. \"jaguar speed -car\"",
			"  - term1 OR term2      — either term, e.g. \"recipes (szechuan OR cantonese)\"",
			"  - term1 AND term2     — both terms",
			"  - *                   — wildcard, e.g. \"best * ever\"",
			"Use the verbatim parameter when you need results containing the query string exactly as typed.",
		],
		parameters: Type.Object({
			queries: Type.Array(
				Type.String({
					description:
						"A search query. Kagi search operators (site:, filetype:, inurl:, intitle:, \"exact phrase\", -exclude, OR, AND) can be embedded directly.",
				}),
				{
					description: "One or more search queries to run in parallel. Include essential context within each query for standalone use.",
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
						"When true, wraps each query in double quotes so Kagi matches the exact phrase as typed — " +
						"equivalent to Kagi's Verbatim Search option. Useful when searching for specific strings, error messages, or exact titles.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const { queries, limit = 10, verbatim = false } = params;

			// Verbatim: wrap each query in double quotes so Kagi matches the exact phrase
			const resolvedQueries = verbatim
				? queries.map((q) => `\u201C${q.replace(/"/g, "\u201C")}\u201D`)
				: queries;

			// Resolve token — fail fast with a clear message
			let token: string;
			try {
				token = resolveToken();
			} catch (err: any) {
				return {
					content: [{ type: "text" as const, text: err.message }],
					details: { queries, limit, resultCount: 0, error: err.message } as WebSearchDetails,
					isError: true,
				};
			}

			// Run all queries in parallel, each with a 10s timeout
			const TIMEOUT_MS = 10_000;
			const withTimeout = (query: string) =>
				Promise.race([
					search(query.trim(), token, limit) as Promise<KagiResponse>,
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error("Search timeout after 10s")), TIMEOUT_MS),
					),
				]);

			const settled = await Promise.allSettled(
				resolvedQueries.map((q) => withTimeout(q)),
			);

			// Check for cancellation after the awaits
			if (signal?.aborted) {
				return {
					content: [{ type: "text" as const, text: "Search was cancelled." }],
					details: { queries, limit, resultCount: 0, error: "cancelled" } as WebSearchDetails,
					isError: true,
				};
			}

			// Collect responses, keeping index alignment for formatter
			const responses: KagiResponse[] = [];
			const errors: string[] = [];
			for (let i = 0; i < settled.length; i++) {
				const s = settled[i];
				if (s.status === "fulfilled") {
					responses.push(s.value);
				} else {
					errors.push(`Query "${resolvedQueries[i]}": ${s.reason?.message ?? String(s.reason)}`);
					responses.push({ data: [] });
				}
			}

			// Count only actual results (t === 0)
			const totalCount = responses.reduce(
				(sum, r) => sum + (r.data ?? []).filter((item) => item.t === 0).length,
				0,
			);
			const allUrls = responses.flatMap((r) =>
				(r.data ?? []).filter((item): item is KagiResult => item.t === 0).map((r) => r.url),
			);

			if (totalCount === 0 && errors.length === 0) {
				return {
					content: [{ type: "text" as const, text: `No results found for: ${queries.join(", ")}` }],
					details: { queries, limit, resultCount: 0 } as WebSearchDetails,
				};
			}

			let text = formatResults(resolvedQueries, responses);
			if (errors.length > 0) {
				text += "\n\nErrors encountered:\n" + errors.join("\n");
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
			if (args.verbatim) text += theme.fg("warning", " verbatim");
			if (args.limit) text += theme.fg("dim", ` (limit: ${args.limit})`);
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
