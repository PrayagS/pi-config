/**
 * Co-Authored-By Extension
 *
 * Automatically appends a Co-Authored-By git trailer to commit messages
 * when the agent runs `git commit`.
 *
 * Example commit message:
 *   fix: resolve null pointer
 *
 *   Co-Authored-By: Claude Sonnet 4 <noreply@pi.dev>
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

function isGitCommit(cmd: string): boolean {
	const normalized = cmd.replace(/\\\n/g, " ");
	return /\bgit\s+commit\b/.test(normalized) && /\s-[^\s]*m\b/.test(normalized);
}

function appendTrailer(cmd: string, modelName: string): string {
	return `${cmd.trimEnd()} -m "" -m "Co-Authored-By: ${modelName} <noreply@pi.dev>"`;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const cmd = event.input.command;
		if (!isGitCommit(cmd)) return;

		const modelName = ctx.model?.name ?? "unknown";

		event.input.command = appendTrailer(cmd, modelName);
	});
}
