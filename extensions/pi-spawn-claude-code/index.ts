import { spawn } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { fileURLToPath } from "node:url"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type {
  AgentToolResult,
  ExtensionAPI,
} from "@mariozechner/pi-coding-agent"
import { Text } from "@mariozechner/pi-tui"
import { Type } from "@sinclair/typebox"

interface ClaudeConfig {
  model?: string
  effort?: string
  allowDangerouslySkipPermissions?: boolean
  allowedTools?: string[] | null
  additionalArgs?: string[]
  blockTimeoutMs?: number
  closePaneOnCompletion?: boolean
}

interface RunDetails {
  runId: string
  mode: "background" | "interactive"
  async: boolean
  exitCode?: number | null
  elapsedMs?: number
  transcriptPath?: string
  status?: "started"
}

interface RunResult {
  runId: string
  mode: "background" | "interactive"
  async: boolean
  report: string
  exitCode: number | null
  elapsedMs: number
  transcriptPath?: string
}

const DEFAULT_BLOCK_TIMEOUT_MS = 600_000
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "plugin")

function loadClaudeConfig(): ClaudeConfig {
  const configPath = join(homedir(), ".pi", "agent", "pi-spawn-claude-code.json")
  try {
    if (!existsSync(configPath)) return {}
    return JSON.parse(readFileSync(configPath, "utf-8")) as ClaudeConfig
  } catch {
    return {}
  }
}

function buildClaudeArgs(
  prompt: string,
  mode: "background" | "interactive",
  config: ClaudeConfig
): string[] {
  const args: string[] = []
  if (mode === "background") args.push("-p")
  if (config.allowDangerouslySkipPermissions !== false)
    args.push("--allow-dangerously-skip-permissions")
  if (config.model) args.push("--model", config.model)
  if (config.effort) args.push("--effort", config.effort)
  if (config.allowedTools)
    args.push("--allowed-tools", config.allowedTools.join(","))
  if (mode === "interactive" && existsSync(PLUGIN_DIR))
    args.push("--plugin-dir", PLUGIN_DIR)
  if (config.additionalArgs?.length) args.push(...config.additionalArgs)
  args.push(prompt)

  return args
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function commandFromArgs(command: string, args: string[]): string {
  return [command, ...args].map(shellEscape).join(" ")
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatResult(result: RunResult): string {
  const lines = [
    `Claude run ${result.runId} completed.`,
    "",
    `Mode: ${result.mode}`,
    `Exit code: ${result.exitCode ?? "unknown"}`,
    `Elapsed: ${formatDuration(result.elapsedMs)}`,
  ]
  if (result.transcriptPath) lines.push(`Transcript: ${result.transcriptPath}`)
  lines.push("", result.report)
  return lines.join("\n")
}

function toolResult(result: RunResult): AgentToolResult<RunDetails> {
  return {
    content: [{ type: "text", text: result.report }],
    details: {
      runId: result.runId,
      mode: result.mode,
      async: result.async,
      exitCode: result.exitCode,
      elapsedMs: result.elapsedMs,
      transcriptPath: result.transcriptPath,
    },
  }
}

function startedResult(runId: string, mode: "background" | "interactive"): AgentToolResult<RunDetails> {
  return {
    content: [{ type: "text", text: `Claude run started: ${runId}` }],
    details: { runId, mode, async: true, status: "started" },
  }
}

function sendAsyncReport(
  pi: ExtensionAPI,
  ctx: { isIdle(): boolean },
  result: RunResult
): void {
  const report = formatResult(result)
  if (ctx.isIdle()) {
    pi.sendUserMessage(report)
  } else {
    pi.sendUserMessage(report, { deliverAs: "steer" })
  }
}

function runBackground(
  runId: string,
  prompt: string,
  cwd: string,
  config: ClaudeConfig,
  signal: AbortSignal | undefined,
  asyncMode: boolean,
): Promise<RunResult> {
  const start = Date.now()
  const child = spawn("claude", buildClaudeArgs(prompt, "background", config), {
    cwd,
    env: process.env,
    signal,
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []

  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))

  return new Promise((resolvePromise) => {
    child.on("error", (error) => {
      resolvePromise({
        runId,
        mode: "background",
        async: asyncMode,
        report: error.message,
        exitCode: null,
        elapsedMs: Date.now() - start,
      })
    })

    child.on("close", (exitCode) => {
      const out = Buffer.concat(stdout).toString("utf-8").trim()
      const err = Buffer.concat(stderr).toString("utf-8").trim()
      resolvePromise({
        runId,
        mode: "background",
        async: asyncMode,
        report: out || err || `Claude exited with code ${exitCode ?? "unknown"}`,
        exitCode,
        elapsedMs: Date.now() - start,
      })
    })
  })
}

function spawnTmux(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn("tmux", args, { cwd, env: process.env })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.on("error", (error) => {
      resolvePromise({ stdout: "", stderr: error.message, exitCode: null })
    })
    child.on("close", (exitCode) => {
      resolvePromise({
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
        exitCode,
      })
    })
  })
}

async function capturePane(paneId: string, cwd: string): Promise<string> {
  const result = await spawnTmux(
    ["capture-pane", "-p", "-t", paneId, "-S", "-200"],
    cwd
  )
  return result.stdout
}

function copyTranscript(cwd: string, transcriptPath: string): string {
  const outDir = join(cwd, ".pi", "agent", "sessions", "pi-spawn-claude-code")
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${Date.now().toString(36)}.jsonl`)
  copyFileSync(transcriptPath, outPath)
  return outPath
}

async function waitForInteractiveCompletion(
  runId: string,
  paneId: string,
  sentinelFile: string,
  cwd: string,
  config: ClaudeConfig,
  signal: AbortSignal | undefined,
): Promise<RunResult> {
  const start = Date.now()
  let exitCode: number | null = null
  let report = ""
  let transcriptPath: string | undefined

  while (!signal?.aborted) {
    if (existsSync(sentinelFile)) {
      try {
        report = readFileSync(sentinelFile, "utf-8").trim()
      } catch {}
      break
    }

    const screen = await capturePane(paneId, cwd)
    const match = screen.match(/__CLAUDE_DONE_(\d+)__/)
    if (match) {
      exitCode = Number.parseInt(match[1], 10)
      report = screen.trim()
      break
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000))
  }

  if (signal?.aborted) {
    report = "Claude run aborted."
  }

  const transcriptFile = `${sentinelFile}.transcript`
  if (existsSync(transcriptFile)) {
    try {
      const sourceTranscript =
        readFileSync(transcriptFile, "utf-8").trim() || undefined
      transcriptPath = sourceTranscript
        ? copyTranscript(cwd, sourceTranscript)
        : undefined
    } catch {}
  }

  if (!report) report = "Claude completed with no final message."

  if (exitCode === null) {
    const screen = await capturePane(paneId, cwd)
    const match = screen.match(/__CLAUDE_DONE_(\d+)__/)
    if (match) exitCode = Number.parseInt(match[1], 10)
  }

  if (config.closePaneOnCompletion !== false) {
    await spawnTmux(["kill-pane", "-t", paneId], cwd)
  }

  try {
    unlinkSync(sentinelFile)
  } catch {}
  try {
    unlinkSync(transcriptFile)
  } catch {}

  return {
    runId,
    mode: "interactive",
    async: false,
    report,
    exitCode,
    elapsedMs: Date.now() - start,
    transcriptPath,
  }
}

async function runInteractive(
  runId: string,
  prompt: string,
  cwd: string,
  config: ClaudeConfig,
  signal: AbortSignal | undefined,
  asyncMode: boolean,
): Promise<RunResult> {
  const pane = await spawnTmux(
    ["split-window", "-d", "-h", "-P", "-F", "#{pane_id}"],
    cwd
  )
  const paneId = pane.stdout.trim()
  if (!paneId || pane.exitCode !== 0) {
    return {
      runId,
      mode: "interactive",
      async: asyncMode,
      report: pane.stderr.trim() || "Failed to create tmux pane.",
      exitCode: pane.exitCode,
      elapsedMs: 0,
    }
  }

  const sentinelFile = `/tmp/pi-claude-${runId}-done`
  const tempDir = mkdtempSync(join(tmpdir(), "pi-claude-"))
  const scriptPath = join(tempDir, "run.sh")
  const command = commandFromArgs(
    "claude",
    buildClaudeArgs(prompt, "interactive", config)
  )
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash\nset -uo pipefail\ncd ${shellEscape(resolve(cwd))}\nPI_CLAUDE_SENTINEL=${shellEscape(sentinelFile)} ${command}\nstatus=$?\necho "__CLAUDE_DONE_\${status}__"\n`,
    { mode: 0o700 },
  )

  await spawnTmux(["send-keys", "-t", paneId, scriptPath, "Enter"], cwd)

  const result = await waitForInteractiveCompletion(runId, paneId, sentinelFile, cwd, config, signal)
  result.async = asyncMode
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {}
  return result
}

function combineSignals(
  signal: AbortSignal | undefined,
  controller: AbortController
): AbortSignal {
  if (!signal) return controller.signal
  if (signal.aborted) controller.abort()
  else signal.addEventListener("abort", () => controller.abort(), { once: true })
  return controller.signal
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController
): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`Claude run timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export default function piSpawnClaudeCodeExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "claude",
    label: "Pi Spawn Claude Code",
    description: "Run Claude Code CLI in background or interactive tmux mode and collect its final report.",
    promptSnippet: "Run Claude Code CLI with a prompt in background or interactive tmux mode",
    promptGuidelines: [
      "Use claude when the user asks to run Claude Code CLI directly.",
      "For async claude runs, wait for the steered completion report instead of assuming the result.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Prompt to pass to Claude Code CLI" }),
      mode: Type.Union([Type.Literal("background"), Type.Literal("interactive")], {
        description: "Run with claude -p in background, or in an interactive tmux pane",
      }),
      async: Type.Boolean({ description: "Return immediately and steer completion later when true" }),
    }),
    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0)
      text.setText(
        `${theme.fg("toolTitle", theme.bold("claude"))}\n${theme.fg("muted", JSON.stringify(args, null, 2))}`
      )
      return text
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const config = loadClaudeConfig()
      const syncController = params.async ? undefined : new AbortController()
      const runSignal = syncController
        ? combineSignals(signal, syncController)
        : undefined
      const run =
        params.mode === "background"
          ? runBackground(
              runId,
              params.prompt,
              ctx.cwd,
              config,
              runSignal,
              params.async
            )
          : runInteractive(
              runId,
              params.prompt,
              ctx.cwd,
              config,
              runSignal,
              params.async
            )

      if (params.async) {
        run.then(
          (result) => sendAsyncReport(pi, ctx, result),
          (error) =>
            sendAsyncReport(pi, ctx, {
              runId,
              mode: params.mode,
              async: true,
              report: error instanceof Error ? error.message : String(error),
              exitCode: null,
              elapsedMs: 0,
            }),
        )
        return startedResult(runId, params.mode)
      }

      try {
        if (!syncController) throw new Error("Missing sync abort controller")
        const result = await withTimeout(
          run,
          config.blockTimeoutMs ?? DEFAULT_BLOCK_TIMEOUT_MS,
          syncController
        )
        return toolResult(result)
      } catch (error) {
        return toolResult({
          runId,
          mode: params.mode,
          async: false,
          report: error instanceof Error ? error.message : String(error),
          exitCode: null,
          elapsedMs: 0,
        })
      }
    },
  })
}
