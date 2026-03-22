/**
 * Co-Authored-By Extension
 *
 * Automatically appends a Co-Authored-By trailer to commit/describe messages
 * when the agent runs `git commit`, `jj commit`, or `jj describe`.
 *
 * Example message:
 *   fix: resolve null pointer
 *
 *   Co-Authored-By: Claude Sonnet 4 <noreply@pi.dev>
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

function hasMessageFlag(cmd: string): boolean {
	return /\s-[^\s]*m\b/.test(cmd) || /\s--message\b/.test(cmd);
}

function isGitCommit(cmd: string): boolean {
	const normalized = cmd.replace(/\\\n/g, " ");
	return /\bgit\s+commit\b/.test(normalized) && hasMessageFlag(normalized);
}

function isJjCommitOrDescribe(cmd: string): boolean {
	const normalized = cmd.replace(/\\\n/g, " ");
	return /\bjj\s+(commit|ci|describe|desc)\b/.test(normalized) && hasMessageFlag(normalized);
}

function appendTrailer(cmd: string, modelName: string): string {
	return `${cmd.trimEnd()} -m "Co-Authored-By: ${modelName} <noreply@pi.dev>"`;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const cmd = event.input.command;
		if (!isGitCommit(cmd) && !isJjCommitOrDescribe(cmd)) return;

		const modelName = ctx.model?.name ?? "unknown";

		event.input.command = appendTrailer(cmd, modelName);
	});
}
