/**
 * Co-Authored-By Extension
 *
 * Automatically appends a Co-Authored-By trailer to commit/describe messages
 * when the agent runs `git commit`, `jj commit`, `jj-hunk commit`, `jj describe`, or `jj new`.
 *
 * Example message:
 *   fix: resolve null pointer
 *
 *   Co-Authored-By: Claude Sonnet 4 <noreply@pi.dev>
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { isToolCallEventType } from "@mariozechner/pi-coding-agent"
import { appendTrailer } from "./rewrite"

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return

    const modelName = ctx.model?.name ?? "unknown"
    event.input.command = appendTrailer(event.input.command, modelName)
  })
}
