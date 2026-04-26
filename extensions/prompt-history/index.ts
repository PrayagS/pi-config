import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type Prompt = {
	text: string;
	timestamp: number;
	sessionPath: string;
};

type SessionMessageEntry = {
	type: "message";
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
		timestamp?: number;
	};
};

const CACHE_TTL_MS = 5_000;
const MAX_PROMPTS = 50;
const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

let cachedPrompts: Prompt[] = [];
let cacheLoadedAt = 0;
let historyIndex = -1;
let activePrefix = "";
let selectedText: string | undefined;

function extractText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;

	const text = content
		.filter((block): block is { type: string; text: string } => {
			return (
				!!block &&
				typeof block === "object" &&
				"type" in block &&
				"text" in block &&
				(block as { type: unknown }).type === "text" &&
				typeof (block as { text: unknown }).text === "string"
			);
		})
		.map((block) => block.text)
		.join("\n")
		.trim();

	return text || undefined;
}

async function listSessionFiles(): Promise<Array<{ path: string; modified: number }>> {
	const files: Array<{ path: string; modified: number }> = [];

	async function walk(dir: string) {
		let entries;
		try {
			entries = await opendir(dir);
		} catch {
			return;
		}

		for await (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(path);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

			try {
				const info = await stat(path);
				files.push({ path, modified: info.mtimeMs });
			} catch {
				// Session disappeared during scan.
			}
		}
	}

	await walk(SESSIONS_DIR);
	return files.sort((a, b) => b.modified - a.modified);
}

async function readPromptsFromSession(sessionPath: string): Promise<Prompt[]> {
	const prompts: Prompt[] = [];
	const stream = createReadStream(sessionPath, { encoding: "utf8" });
	stream.on("error", () => undefined);

	const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	try {
		for await (const line of lines) {
			if (!line.trim()) continue;

			let entry: SessionMessageEntry;
			try {
				entry = JSON.parse(line) as SessionMessageEntry;
			} catch {
				continue;
			}

			if (entry.type !== "message" || entry.message?.role !== "user") continue;

			const text = extractText(entry.message.content)?.trim();
			if (!text) continue;

			prompts.push({
				text,
				timestamp: entry.message.timestamp ?? (Date.parse(entry.timestamp ?? "") || 0),
				sessionPath,
			});
		}
	} catch {
		return prompts;
	}

	return prompts;
}

async function loadAllPrompts(): Promise<Prompt[]> {
	const now = Date.now();
	if (now - cacheLoadedAt < CACHE_TTL_MS) return cachedPrompts;

	const seen = new Set<string>();
	const prompts: Prompt[] = [];

	for (const session of await listSessionFiles()) {
		const sessionPrompts = await readPromptsFromSession(session.path);
		for (const prompt of sessionPrompts.reverse()) {
			if (seen.has(prompt.text)) continue;
			seen.add(prompt.text);
			prompts.push(prompt);
			if (prompts.length >= MAX_PROMPTS) break;
		}
		if (prompts.length >= MAX_PROMPTS) break;
	}

	cachedPrompts = prompts.sort((a, b) => b.timestamp - a.timestamp);
	cacheLoadedAt = now;
	return cachedPrompts;
}

async function recallPrompt(ctx: ExtensionContext, direction: "previous" | "next") {
	const editorText = ctx.ui.getEditorText();
	if (historyIndex === -1 || editorText !== selectedText) {
		activePrefix = editorText;
		historyIndex = -1;
		selectedText = undefined;
	}

	const prompts = (await loadAllPrompts()).filter((prompt) => prompt.text.startsWith(activePrefix));
	if (prompts.length === 0) {
		ctx.ui.notify("No matching prompt history", "info");
		return;
	}

	if (direction === "previous") {
		historyIndex = Math.min(historyIndex + 1, prompts.length - 1);
	} else {
		historyIndex = Math.max(historyIndex - 1, -1);
	}

	selectedText = historyIndex === -1 ? activePrefix : prompts[historyIndex].text;
	ctx.ui.setEditorText(selectedText);
}

export default function (pi: ExtensionAPI) {
	pi.registerShortcut("ctrl+k", {
		description: "Recall older prompt from all Pi sessions",
		handler: async (ctx) => {
			await recallPrompt(ctx, "previous");
		},
	});

	pi.registerShortcut("ctrl+j", {
		description: "Recall newer prompt from all Pi sessions",
		handler: async (ctx) => {
			await recallPrompt(ctx, "next");
		},
	});

	pi.on("input", () => {
		historyIndex = -1;
		activePrefix = "";
		selectedText = undefined;
		cacheLoadedAt = 0;
		return { action: "continue" };
	});
}
