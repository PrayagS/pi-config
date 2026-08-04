import * as fs from "node:fs"
import { homedir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

const PROMPT_SUFFIX = ".prompt.md"
const STATUS_ID = "output-style"
const CONFIG_PATH = path.join(homedir(), ".pi", "agent", "output-style.json")

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export type StylePrompts = Map<string, string>
export type ActiveStyles = string[]

export function normalizeStyles(
  values: unknown,
  prompts: StylePrompts
): ActiveStyles {
  if (!Array.isArray(values)) return []

  const selected = new Set(
    values.filter((value): value is string => typeof value === "string")
  )
  return [...prompts.keys()].filter((name) => selected.has(name))
}

export function saveGlobalStyles(
  styles: ActiveStyles,
  configPath = CONFIG_PATH
) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  const tempPath = `${configPath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify({ styles }, null, 2)}\n`)
    fs.renameSync(tempPath, configPath)
  } catch (error) {
    fs.rmSync(tempPath, { force: true })
    throw error
  }
}

export function loadGlobalStyles(
  prompts: StylePrompts,
  configPath = CONFIG_PATH
): ActiveStyles {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      style?: unknown
      styles?: unknown
    }
    const legacy =
      !Array.isArray(parsed.styles) && typeof parsed.style === "string"
    const configuredStyles = Array.isArray(parsed.styles)
      ? parsed.styles
      : legacy
        ? [parsed.style]
        : []
    const styles = normalizeStyles(configuredStyles, prompts)

    if (legacy) {
      try {
        saveGlobalStyles(styles, configPath)
      } catch {
        // Keep the migrated style active when rewriting the config fails.
      }
    }

    return styles
  } catch {
    return []
  }
}

export function buildStylePrompt(
  styles: ActiveStyles,
  prompts: StylePrompts
): string {
  return normalizeStyles(styles, prompts)
    .map(
      (name) => `\n\nOUTPUT STYLE ACTIVE — ${name}\n\n${prompts.get(name)}`
    )
    .join("")
}

function loadStylePrompts(): StylePrompts {
  const prompts = new Map<string, string>()

  for (const filename of fs.readdirSync(__dirname).sort()) {
    if (!filename.endsWith(PROMPT_SUFFIX)) continue

    const name = filename.slice(0, -PROMPT_SUFFIX.length)
    const content = fs
      .readFileSync(path.join(__dirname, filename), "utf8")
      .trim()
    if (!content) throw new Error(`output style prompt is empty: ${filename}`)
    prompts.set(name, content)
  }

  if (prompts.size === 0)
    throw new Error(`no output style prompts found in ${__dirname}`)

  return prompts
}

export default function outputStyleExtension(pi: ExtensionAPI) {
  let prompts: StylePrompts = new Map()
  let activeStyles: ActiveStyles = []
  let cachedPrompt = ""

  function applyStyles(
    styles: ActiveStyles,
    ctx?: { ui: { setStatus: (id: string, text?: string) => void } }
  ) {
    activeStyles = normalizeStyles(styles, prompts)
    cachedPrompt = buildStylePrompt(activeStyles, prompts)
    const status =
      activeStyles.length > 0 ? `✍️ ${activeStyles.join(" + ")}` : undefined
    ctx?.ui.setStatus(STATUS_ID, status)
  }

  pi.on("session_start", async (_event, ctx) => {
    prompts = loadStylePrompts()
    applyStyles(loadGlobalStyles(prompts), ctx)
  })

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_ID, undefined)
  })

  pi.registerCommand("output-style", {
    description: "Show or set output styles: /output-style [off|<style> ...]",
    getArgumentCompletions: (prefix) => {
      const match = prefix.toLowerCase().match(/^(.*(?:^|[\s,]))?([^\s,]*)$/)
      const leading = match?.[1] ?? ""
      const current = match?.[2] ?? ""
      const selected = new Set(
        leading
          .split(/[\s,]+/)
          .map((name) => name.trim())
          .filter(Boolean)
      )
      const names = leading ? [...prompts.keys()] : ["off", ...prompts.keys()]
      const values = names
        .filter((name) => !selected.has(name) && name.startsWith(current))
        .map((name) => ({ value: `${leading}${name}`, label: name }))
      return values.length > 0 ? values : null
    },
    handler: async (args, ctx) => {
      const requested = args
        .trim()
        .toLowerCase()
        .split(/[\s,]+/)
        .filter(Boolean)
      if (requested.length === 0) {
        const active = activeStyles.length > 0 ? activeStyles.join(", ") : "off"
        const available = [...prompts.keys()].join(", ")
        ctx.ui.notify(
          `output styles: ${active}. Available: ${available}`,
          "info"
        )
        return
      }

      if (requested.includes("off") && requested.length > 1) {
        ctx.ui.notify(
          "Output style 'off' cannot be combined with a style.",
          "error"
        )
        return
      }

      const unknown = requested.find(
        (name) => name !== "off" && !prompts.has(name)
      )
      if (unknown) {
        ctx.ui.notify(`Unknown output style: ${unknown}`, "error")
        return
      }

      const nextStyles =
        requested[0] === "off" ? [] : normalizeStyles(requested, prompts)
      applyStyles(nextStyles, ctx)
      try {
        saveGlobalStyles(nextStyles)
        const savedStyles =
          nextStyles.length > 0 ? nextStyles.join(", ") : "off"
        ctx.ui.notify(`global output styles: ${savedStyles}`, "info")
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const warning =
          `output styles active for this session, but global save failed: ` +
          message
        ctx.ui.notify(warning, "warning")
      }
    },
  })

  pi.on("before_agent_start", async (event) => {
    if (!cachedPrompt) return undefined
    return { systemPrompt: `${event.systemPrompt}${cachedPrompt}` }
  })
}
