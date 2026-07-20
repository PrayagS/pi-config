import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"

const CONFIG_PATH = join(homedir(), ".pi", "agent", "prewalk.json")
const PLAN_MESSAGE_TYPE = "prewalk-plan"
const CONTINUE_MESSAGE_TYPE = "prewalk-continue"
const CHECKLIST_MESSAGE_TYPE = "prewalk-checklist"
const ACTION_TOOLS = new Set(["edit", "write"])
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

type ThinkingLevel = (typeof THINKING_LEVELS)[number]
type TargetModel = NonNullable<ExtensionContext["model"]>
type Phase = "idle" | "armed"

interface PrewalkConfig {
  target?: string
  thinkingLevel?: ThinkingLevel
}

interface Target {
  model: TargetModel
  thinkingLevel?: ThinkingLevel
}

const PLAN_PROMPT = `Before implementing, inspect the relevant code deeply enough to understand the request, architecture, conventions, and every likely change site.

Then state a concrete implementation plan in your next reply. Make the plan specific enough that another model can finish the work from the conversation alone: name files, symbols, invariants, edge cases, and verification commands. If a todo tool is available, create the todo list from that plan before editing. Start the implementation yourself after planning; do not stop after presenting the plan. Keep using tools until you make the first real edit or write.`

const CHECKLIST_PROMPT = `Continue implementing the plan already established in this conversation. Before finishing:

1. Re-read the original request and the plan; confirm every requirement and change site is covered.
2. Keep the change narrow; do not replace working code outside the requested scope.
3. Run the relevant verification commands yourself. Do not rely only on earlier or reported results.
4. Inspect the final diff for omissions, unrelated changes, and temporary artifacts.`

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === "string" &&
    THINKING_LEVELS.includes(value as ThinkingLevel)
  )
}

async function loadConfig(): Promise<PrewalkConfig> {
  try {
    const parsed: unknown = JSON.parse(await readFile(CONFIG_PATH, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

    const record = parsed as Record<string, unknown>
    return {
      target: typeof record.target === "string" ? record.target : undefined,
      thinkingLevel: isThinkingLevel(record.thinkingLevel)
        ? record.thinkingLevel
        : undefined,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
}

async function saveConfig(config: PrewalkConfig): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true })
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

function parseTargetArgs(args: string): {
  modelRef?: string
  thinkingLevel?: ThinkingLevel
  error?: string
} {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return {}
  if (parts.length > 2) {
    return { error: "Usage: /prewalk [provider/model] [thinking-level]" }
  }

  const thinkingLevel = parts[1]
  if (thinkingLevel && !isThinkingLevel(thinkingLevel)) {
    return {
      error: `Invalid thinking level. Use: ${THINKING_LEVELS.join(", ")}`,
    }
  }

  return { modelRef: parts[0], thinkingLevel }
}

function resolveTarget(
  modelRef: string,
  thinkingLevel: ThinkingLevel | undefined,
  ctx: ExtensionContext
): Target | string {
  const slash = modelRef.indexOf("/")
  if (slash <= 0 || slash === modelRef.length - 1) {
    return `Invalid model "${modelRef}". Use provider/model.`
  }

  const model = ctx.modelRegistry.find(
    modelRef.slice(0, slash),
    modelRef.slice(slash + 1)
  )
  if (!model) return `Model "${modelRef}" not found.`
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    return `No configured authentication for ${modelRef}.`
  }

  return { model, thinkingLevel }
}

function modelRef(model: TargetModel): string {
  return `${model.provider}/${model.id}`
}

function isCurrentPlanMessage(
  message: { role: string; customType?: string; details?: unknown },
  phase: Phase,
  runId: string | undefined
): boolean {
  if (message.role !== "custom" || message.customType !== PLAN_MESSAGE_TYPE) {
    return true
  }
  if (phase !== "armed" || !runId) return false
  if (!message.details || typeof message.details !== "object") return false
  return (message.details as { runId?: unknown }).runId === runId
}

export default function prewalk(pi: ExtensionAPI) {
  let phase: Phase = "idle"
  let target: Target | undefined
  let runId: string | undefined
  let planInjected = false
  let continuePending = false
  let todoSeen = false

  function clear(ctx?: ExtensionContext) {
    phase = "idle"
    target = undefined
    runId = undefined
    planInjected = false
    continuePending = false
    todoSeen = false
    ctx?.ui.setStatus("prewalk", undefined)
  }

  function arm(nextTarget: Target, ctx: ExtensionContext) {
    phase = "armed"
    target = nextTarget
    runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    planInjected = false
    continuePending = false
    todoSeen = false
    ctx.ui.setStatus("prewalk", `prewalk: ${modelRef(nextTarget.model)}`)
    ctx.ui.notify(
      `Prewalk armed. Will switch to ${modelRef(nextTarget.model)} after the first successful edit/write${
        pi.getActiveTools().includes("todo") ? " once the todo list exists" : ""
      }.`,
      "info"
    )
  }

  async function chooseTarget(ctx: ExtensionContext): Promise<Target | undefined> {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "No prewalk target configured. Use /prewalk provider/model [thinking-level].",
        "warning"
      )
      return undefined
    }

    const choices = ctx.modelRegistry
      .getAvailable()
      .map(modelRef)
      .sort((a, b) => a.localeCompare(b))
    const selected = await ctx.ui.select("Prewalk target", choices)
    if (!selected) return undefined

    const resolved = resolveTarget(selected, undefined, ctx)
    if (typeof resolved === "string") {
      ctx.ui.notify(resolved, "error")
      return undefined
    }
    await saveConfig({ target: selected })
    return resolved
  }

  async function configuredTarget(
    ctx: ExtensionContext,
    override?: string
  ): Promise<Target | undefined> {
    const config = await loadConfig()
    const ref = override || config.target
    if (!ref) return chooseTarget(ctx)

    const thinkingLevel =
      !override || override === config.target ? config.thinkingLevel : undefined
    const resolved = resolveTarget(ref, thinkingLevel, ctx)
    if (typeof resolved === "string") {
      ctx.ui.notify(resolved, "error")
      return undefined
    }
    return resolved
  }

  pi.registerFlag("prewalk", {
    description: "Arm a strong-to-fast model handoff for this session",
    type: "boolean",
    default: false,
  })
  pi.registerFlag("prewalk-target", {
    description: "Target provider/model for --prewalk",
    type: "string",
  })

  pi.registerCommand("prewalk", {
    description:
      "Plan with the current model, then switch after its first edit/write",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase()
      const values = ["off", "status", "target"]
        .filter(value => value.startsWith(normalized))
        .map(value => ({ value, label: value }))
      return values.length > 0 ? values : null
    },
    handler: async (args, ctx) => {
      const input = args.trim()
      if (input === "off") {
        clear(ctx)
        ctx.ui.notify("Prewalk disabled.", "info")
        return
      }
      if (input === "status") {
        const config = await loadConfig()
        const state =
          phase === "armed" && target
            ? `armed for ${modelRef(target.model)}`
            : "idle"
        ctx.ui.notify(
          `Prewalk ${state}. Configured target: ${config.target ?? "none"}.`,
          "info"
        )
        return
      }
      if (input === "target" || input.startsWith("target ")) {
        const targetArgs = parseTargetArgs(input.slice("target".length))
        if (targetArgs.error) {
          ctx.ui.notify(targetArgs.error, "error")
          return
        }

        let selected: Target | undefined
        if (targetArgs.modelRef) {
          const resolved = resolveTarget(
            targetArgs.modelRef,
            targetArgs.thinkingLevel,
            ctx
          )
          if (typeof resolved === "string") {
            ctx.ui.notify(resolved, "error")
            return
          }
          selected = resolved
        } else {
          selected = await chooseTarget(ctx)
        }
        if (!selected) return

        await saveConfig({
          target: modelRef(selected.model),
          thinkingLevel: selected.thinkingLevel,
        })
        ctx.ui.notify(
          `Prewalk target saved: ${modelRef(selected.model)}${
            selected.thinkingLevel ? ` (${selected.thinkingLevel})` : ""
          }.`,
          "success"
        )
        return
      }

      const parsed = parseTargetArgs(input)
      if (parsed.error) {
        ctx.ui.notify(parsed.error, "error")
        return
      }

      let nextTarget: Target | undefined
      if (parsed.modelRef) {
        const resolved = resolveTarget(
          parsed.modelRef,
          parsed.thinkingLevel,
          ctx
        )
        if (typeof resolved === "string") {
          ctx.ui.notify(resolved, "error")
          return
        }
        nextTarget = resolved
      } else {
        nextTarget = await configuredTarget(ctx)
      }
      if (nextTarget) arm(nextTarget, ctx)
    },
  })

  pi.on("session_start", async (_event, ctx) => {
    clear(ctx)
    const enabled = pi.getFlag("prewalk") === true
    const override = pi.getFlag("prewalk-target")
    if (!enabled && typeof override !== "string") return

    const nextTarget = await configuredTarget(
      ctx,
      typeof override === "string" ? override : undefined
    )
    if (nextTarget) arm(nextTarget, ctx)
  })

  pi.on("before_agent_start", async () => {
    if (phase !== "armed" || !target || !runId || planInjected) return
    planInjected = true
    continuePending = true
    return {
      message: {
        customType: PLAN_MESSAGE_TYPE,
        content: PLAN_PROMPT,
        display: false,
        details: { runId },
      },
    }
  })

  pi.on("context", event => {
    const messages = event.messages.filter(message =>
      isCurrentPlanMessage(message, phase, runId)
    )
    return messages.length === event.messages.length ? undefined : { messages }
  })

  pi.on("turn_end", async (event, ctx) => {
    if (phase !== "armed" || !target || event.message.role !== "assistant") {
      return
    }

    if (
      event.toolResults.some(
        result => result.toolName === "todo" && !result.isError
      )
    ) {
      todoSeen = true
    }

    const todoGateOpen = todoSeen || !pi.getActiveTools().includes("todo")
    const action = todoGateOpen
      ? event.toolResults.find(
          result => ACTION_TOOLS.has(result.toolName) && !result.isError
        )
      : undefined

    const hasToolResults = event.toolResults.length > 0
    if (planInjected && hasToolResults) {
      continuePending = true
    } else if (continuePending) {
      continuePending = false
      pi.sendMessage(
        {
          customType: CONTINUE_MESSAGE_TYPE,
          content: "Continue the task now. Do not end the run after planning.",
          display: false,
        },
        { triggerTurn: true, deliverAs: "steer" }
      )
    }

    if (!action) return

    const completedTarget = target
    const switched = await pi.setModel(completedTarget.model)
    if (!switched) {
      ctx.ui.notify(
        `Prewalk could not switch to ${modelRef(completedTarget.model)}.`,
        "error"
      )
      clear(ctx)
      return
    }
    if (completedTarget.thinkingLevel) {
      pi.setThinkingLevel(completedTarget.thinkingLevel)
    }

    clear(ctx)
    ctx.ui.notify(
      `Prewalk switched to ${modelRef(completedTarget.model)} after ${action.toolName}.`,
      "success"
    )
    pi.sendMessage(
      {
        customType: CHECKLIST_MESSAGE_TYPE,
        content: CHECKLIST_PROMPT,
        display: false,
      },
      { triggerTurn: true, deliverAs: "steer" }
    )
  })
}
