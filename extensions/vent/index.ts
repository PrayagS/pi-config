import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, isAbsolute, resolve } from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent"
import { Text } from "@mariozechner/pi-tui"
import { Type } from "@sinclair/typebox"

const AGENT_DIR = resolve(homedir(), ".pi", "agent")
const VENT_JSONL = resolve(AGENT_DIR, "vent.jsonl")
const VENT_ARCHIVE_JSONL = resolve(AGENT_DIR, "vent-archive.jsonl")

const VENT_TOOL_DESCRIPTION =
  "Append workflow-friction feedback to the shared vent log at ~/.pi/agent/vent.jsonl."

const ventSchema = Type.Object(
  {
    thought: Type.String({
      description: "Vent entry text.",
    }),
    trigger: Type.Optional(
      Type.String({ description: "Optional short trigger label." })
    ),
  },
  { additionalProperties: false }
)

interface VentEntry {
  timestamp: string
  project: string
  cwd: string
  trigger?: string
  thought: string
}

function clean(input: string): string {
  return input.trim().replace(/\r\n/g, "\n")
}

async function readEntries(path: string): Promise<VentEntry[]> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const entries: VentEntry[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as VentEntry)
    } catch {
      // skip malformed lines rather than failing the whole read
    }
  }
  return entries
}

function entryHeading(entry: VentEntry): string {
  const local = entry.timestamp.replace("T", " ").slice(0, 16)
  const label = entry.trigger ? `${local} — ${entry.trigger}` : local
  return `### ${label}`
}

function renderMarkdown(entries: VentEntry[], exportedAt: string): string {
  const lines: string[] = [
    "# Vent log",
    "",
    `Exported from \`${VENT_JSONL}\` at ${exportedAt}.`,
    "",
  ]
  const byProject = new Map<string, VentEntry[]>()
  for (const entry of entries) {
    const group = byProject.get(entry.project) ?? []
    group.push(entry)
    byProject.set(entry.project, group)
  }
  for (const [project, group] of byProject) {
    lines.push(
      `## ${project} (${group.length} ${group.length === 1 ? "entry" : "entries"})`
    )
    lines.push("")
    const cwd = group[group.length - 1].cwd
    if (cwd?.trim()) {
      lines.push(`Path: \`${cwd}\``)
      lines.push("")
    }
    for (const entry of group) {
      lines.push(entryHeading(entry))
      lines.push("")
      lines.push(entry.thought)
      lines.push("")
    }
  }
  return `${lines.join("\n").trimEnd()}\n`
}

export default function ventExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "vent",
    label: "vent",
    description: VENT_TOOL_DESCRIPTION,
    promptSnippet: "Log repeated workflow friction.",
    promptGuidelines: [
      "vent: Use for repeated or systemic workflow friction, especially when the same manual workaround happens more than once.",
      "vent: Use after a second hook/tool failure with the same root cause, or when tool output forces the same retry sequence.",
      "vent: Use when project instructions, docs, or tooling cause avoidable backtracking that should become automation, docs, or workflow fixes.",
      "vent: Do not use for one-off lint/type errors or ordinary coding mistakes.",
      "vent: Call near the end of the turn after completing the task; batch related feedback instead of calling repeatedly.",
      "vent: Include what failed, what workaround was repeated, and what would prevent it next time; never use vent as a substitute for finishing the task.",
      "vent: Entries go to a shared log at ~/.pi/agent/vent.jsonl; the current project context is captured automatically.",
    ],
    parameters: ventSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const thought = clean(params.thought)
      if (!thought) throw new Error("vent.thought must not be empty")

      const trigger = params.trigger ? clean(params.trigger) : undefined
      const project = basename(ctx.cwd) || ctx.cwd
      const entry: VentEntry = {
        timestamp: new Date().toISOString(),
        project,
        cwd: ctx.cwd,
        ...(trigger ? { trigger } : {}),
        thought,
      }

      await withFileMutationQueue(VENT_JSONL, async () => {
        await mkdir(AGENT_DIR, { recursive: true })
        await appendFile(VENT_JSONL, `${JSON.stringify(entry)}\n`, "utf8")
      })

      return {
        content: [
          {
            type: "text" as const,
            text: `Appended vent entry to ~/.pi/agent/vent.jsonl (${entry.timestamp}).`,
          },
        ],
        details: {
          path: "~/.pi/agent/vent.jsonl",
          timestamp: entry.timestamp,
          project,
          trigger,
          thought,
        },
      }
    },

    renderCall(args, theme, _context) {
      const trigger =
        typeof args?.trigger === "string" && args.trigger.trim()
          ? ` ${args.trigger.trim()}`
          : ""
      return new Text(
        `${theme.fg("toolTitle", theme.bold("vent"))}${theme.fg("muted", trigger)}`,
        0,
        0
      )
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as
        | { timestamp?: unknown; project?: unknown; thought?: unknown }
        | undefined
      const timestamp =
        typeof details?.timestamp === "string"
          ? details.timestamp.replace("T", " ").slice(0, 16)
          : "saved"
      let text = `${theme.fg("success", "✓")} vented to ${theme.fg("accent", "vent.jsonl")}`
      if (typeof details?.project === "string" && details.project) {
        text += ` ${theme.fg("dim", `[${details.project}]`)}`
      }
      text += ` ${theme.fg("dim", timestamp)}`

      if (expanded && typeof details?.thought === "string") {
        text += `\n\n${details.thought}`
      }

      return new Text(text, 0, 0)
    },
  })

  pi.registerCommand("vent-export", {
    description:
      "Export vent entries from ~/.pi/agent/vent.jsonl to a markdown file",
    handler: async (args, ctx) => {
      const outputPath = args.trim()
        ? isAbsolute(args.trim())
          ? args.trim()
          : resolve(ctx.cwd, args.trim())
        : resolve(ctx.cwd, "VENT.md")

      const entries = await readEntries(VENT_JSONL)
      if (entries.length === 0) {
        ctx.ui.notify("No vent entries to export", "warning")
        return
      }

      const markdown = renderMarkdown(entries, new Date().toISOString())
      await writeFile(outputPath, markdown, "utf8")
      ctx.ui.notify(
        `Exported ${entries.length} vent ${entries.length === 1 ? "entry" : "entries"} to ${outputPath}`,
        "success"
      )
    },
  })

  pi.registerCommand("vent-review", {
    description:
      "Review all vent entries, derive insights, update context files, then archive",
    handler: async (args, _ctx) => {
      const entries = await readEntries(VENT_JSONL)
      const userInstructions = args.trim() || "(none)"

      await pi.sendUserMessage(`Review the accumulated vent entries and turn recurring friction into durable improvements.

Active entries: ${VENT_JSONL} (${entries.length} ${entries.length === 1 ? "entry" : "entries"})
Archive: ${VENT_ARCHIVE_JSONL}

Each entry records the project it belongs to (project name and cwd), a timestamp, an optional trigger label, and the friction note.

Steps:

1. Read the active entries in ${VENT_JSONL}. Group them by project and by recurring trigger or pattern.
2. Identify systemic friction worth fixing. Ignore one-off noise and entries already addressed.
3. For each insight with a durable fix, add the relevant instructions to the right context file:
   - project-specific friction -> that project's AGENTS.md (or equivalent instructions file) at the recorded cwd
   - cross-project friction -> ~/.pi/agent/AGENTS.md or a suitable skill
   Keep additions minimal and concrete; prefer extending existing sections over creating new ones. Do not invent friction that is not in the entries.
4. Summarize the insights and the exact context-file changes you made.
5. Once every active entry has been reviewed and either acted on or deliberately discarded, run /vent-archive to move the entries to ${VENT_ARCHIVE_JSONL}. Do not archive entries you have not reviewed.

User instructions: ${userInstructions}`)
    },
  })

  pi.registerCommand("vent-archive", {
    description:
      "Move all reviewed vent entries from vent.jsonl to vent-archive.jsonl",
    handler: async (_args, ctx) => {
      const entries = await readEntries(VENT_JSONL)
      if (entries.length === 0) {
        ctx.ui.notify("No vent entries to archive", "warning")
        return
      }

      await withFileMutationQueue(VENT_ARCHIVE_JSONL, async () => {
        await mkdir(AGENT_DIR, { recursive: true })
        const payload = entries.map((entry) => JSON.stringify(entry)).join("\n")
        await appendFile(VENT_ARCHIVE_JSONL, `${payload}\n`, "utf8")
      })
      await withFileMutationQueue(VENT_JSONL, async () => {
        await writeFile(VENT_JSONL, "", "utf8")
      })

      ctx.ui.notify(
        `Archived ${entries.length} vent ${entries.length === 1 ? "entry" : "entries"} to ${VENT_ARCHIVE_JSONL}`,
        "success"
      )
    },
  })
}
