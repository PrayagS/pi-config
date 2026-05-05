/**
 * Working Indicator Extension
 *
 * Phase-aware working indicator that changes shape and speed
 * based on what the agent is doing:
 *
 *   thinking  — noise/static, contemplative (120ms)
 *   tool      — vertical block pulse, active (40ms)
 *   streaming — noise/static, contemplative (120ms)
 *   working   — vertical block pulse, active (40ms)
 *
 * Commands:
 *   /working-indicator           Show current phase
 *   /working-indicator on        Enable phase-aware indicators
 *   /working-indicator off       Disable (restore default)
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  WorkingIndicatorOptions,
} from "@mariozechner/pi-coding-agent"
import spinners, { type Spinner } from "unicode-animations"

// ── Raw frame definitions (colored at runtime via theme) ────────

interface IndicatorDef {
  frames: readonly string[]
  intervalMs: number
}

function fromSpinner(spinner: Spinner): IndicatorDef {
  return {
    frames: spinner.frames,
    intervalMs: spinner.interval,
  }
}

const THINKING_DEF = fromSpinner(spinners.waverows)
const TOOL_DEF = fromSpinner(spinners.pulse)
const STREAMING_DEF = fromSpinner(spinners.rain)
const WORKING_DEF = fromSpinner(spinners.helix)

// ── Phase state ─────────────────────────────────────────────────

type Phase = "idle" | "working" | "thinking" | "tool" | "streaming"

function colorize(
  def: IndicatorDef,
  colorFn: (s: string) => string
): WorkingIndicatorOptions {
  return {
    frames: def.frames.map(colorFn),
    intervalMs: def.intervalMs,
  }
}

export default function (pi: ExtensionAPI) {
  let enabled = true
  let isThinking = false
  let isToolRunning = false
  let isStreaming = false
  let currentPhase: Phase = "idle"

  // Colored indicators — built on session_start with theme accent
  let THINKING: WorkingIndicatorOptions
  let TOOL: WorkingIndicatorOptions
  let STREAMING: WorkingIndicatorOptions
  let WORKING: WorkingIndicatorOptions

  function buildIndicators(ctx: ExtensionContext) {
    const accent = (s: string) => ctx.ui.theme.fg("accent", s)
    THINKING = colorize(THINKING_DEF, accent)
    TOOL = colorize(TOOL_DEF, accent)
    STREAMING = colorize(STREAMING_DEF, accent)
    WORKING = colorize(WORKING_DEF, accent)
  }

  function indicatorForPhase(phase: Phase): WorkingIndicatorOptions {
    switch (phase) {
      case "thinking":
        return THINKING
      case "tool":
        return TOOL
      case "streaming":
        return STREAMING
      default:
        return WORKING
    }
  }

  function resolvePhase(): Phase {
    if (isThinking) return "thinking"
    if (isToolRunning) return "tool"
    if (isStreaming) return "streaming"
    return "working"
  }

  function applyPhase(ctx: ExtensionContext) {
    if (!enabled) return
    const phase = resolvePhase()
    if (phase === currentPhase) return
    currentPhase = phase
    ctx.ui.setWorkingIndicator(indicatorForPhase(phase))
  }

  // ── Events ──────────────────────────────────────────────────

  pi.on("session_start", async (_e, ctx) => {
    buildIndicators(ctx)
  })

  pi.on("agent_start", async (_e, ctx) => {
    isThinking = false
    isToolRunning = false
    isStreaming = false
    currentPhase = "idle"
    applyPhase(ctx)
  })

  pi.on("agent_end", async (_e, ctx) => {
    isThinking = false
    isToolRunning = false
    isStreaming = false
    currentPhase = "idle"
    ctx.ui.setWorkingIndicator()
  })

  pi.on("message_update", async (event, ctx) => {
    const se = event.assistantMessageEvent as { type: string }
    if (!se?.type) return

    if (se.type === "thinking_start" || se.type === "thinking_delta") {
      isThinking = true
    } else if (se.type === "thinking_end") {
      isThinking = false
    } else if (se.type === "text_delta") {
      isThinking = false
      isStreaming = true
    }

    applyPhase(ctx)
  })

  pi.on("message_end", async (_e, _ctx) => {
    isThinking = false
    isStreaming = false
  })

  pi.on("tool_execution_start", async (_e, ctx) => {
    isToolRunning = true
    applyPhase(ctx)
  })

  pi.on("tool_execution_end", async (_e, ctx) => {
    isToolRunning = false
    applyPhase(ctx)
  })

  // ── Command ─────────────────────────────────────────────────

  pi.registerCommand("working-indicator", {
    description: "Phase-aware working indicator: on/off",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase()

      if (arg === "off") {
        enabled = false
        ctx.ui.setWorkingIndicator()
        ctx.ui.notify(
          "Working indicator: default (phase-aware disabled)",
          "info"
        )
        return
      }

      if (arg === "on") {
        enabled = true
        currentPhase = "idle"
        applyPhase(ctx)
        ctx.ui.notify("Working indicator: phase-aware enabled", "info")
        return
      }

      const status = enabled
        ? `Phase-aware enabled — current: ${currentPhase}`
        : "Phase-aware disabled (using pi default)"
      ctx.ui.notify(`Working indicator: ${status}`, "info")
    },
  })
}
