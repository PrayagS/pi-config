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

function hasMessageFlag(cmd: string): boolean {
  return /\s-[^\s]*m\b/.test(cmd) || /\s--message\b/.test(cmd)
}

function isGitCommit(cmd: string): boolean {
  const normalized = cmd.replace(/\\\n/g, " ")
  return /\bgit\s+commit\b/.test(normalized) && hasMessageFlag(normalized)
}

function isJjCommitOrDescribe(cmd: string): boolean {
  const normalized = cmd.replace(/\\\n/g, " ")
  return (
    /\b(jj-hunk\s+commit|jj\s+(commit|ci|describe|desc|new))\b/.test(
      normalized,
    ) && hasMessageFlag(normalized)
  )
}

const COMMIT_SUBCOMMAND =
  /\b(?:jj-hunk\s+commit|jj\s+(?:commit|ci|describe|desc|new)|git\s+commit)\b/g

/**
 * Find the end position of a subcommand starting at `startPos`, stopping at the
 * next unquoted shell separator (`&`, `|`, `;`, newline). Quoted strings,
 * backslash escapes, and command substitutions are skipped, so separators
 * inside `-m "..."` or `$(... ; ...)` do not end the subcommand.
 */
function findSubcommandEnd(cmd: string, startPos: number): number {
  let inSingle = false
  let inDouble = false
  let depth = 0
  for (let i = startPos; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === "\\" && !inSingle) {
      i++ // escaped char, including a `\<newline>` line continuation
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (inSingle || inDouble) continue
    if (ch === "(") {
      depth++
      continue
    }
    if (ch === ")") {
      if (depth > 0) depth--
      continue
    }
    if (depth > 0) continue
    if (ch === "&" || ch === "|" || ch === ";" || ch === "\n") return i
  }
  return cmd.length
}

function appendTrailer(cmd: string, modelName: string): string {
  const trailer = `-m "Co-Authored-By: ${modelName} <noreply@pi.dev>"`

  // Locate every commit subcommand within a potentially compound bash command.
  // Appending to the full string breaks with `jj describe -m "..." && cmd2` or a
  // multi-line script, because the trailer lands on the wrong command.
  const starts: number[] = []
  for (const match of cmd.matchAll(COMMIT_SUBCOMMAND)) {
    if (match.index !== undefined) starts.push(match.index)
  }

  if (starts.length === 0) {
    return `${cmd.trimEnd()} ${trailer}`
  }

  // Insert from last to first so earlier offsets stay valid.
  let result = cmd
  for (const start of starts.reverse()) {
    const endPos = findSubcommandEnd(result, start)
    // Skip subcommands with no message of their own (e.g. a bare `jj new`),
    // otherwise the trailer would become the whole description.
    if (!hasMessageFlag(result.slice(start, endPos))) continue
    const before = result.slice(0, endPos).trimEnd()
    const rest = result.slice(endPos)
    const gap = rest.startsWith("\n") ? "" : " "
    result = `${before} ${trailer}${rest ? gap + rest : ""}`
  }
  return result
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return

    const cmd = event.input.command
    if (!isGitCommit(cmd) && !isJjCommitOrDescribe(cmd)) return

    const modelName = ctx.model?.name ?? "unknown"

    event.input.command = appendTrailer(cmd, modelName)
  })
}
