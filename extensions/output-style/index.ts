import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

const PROMPT_SUFFIX = ".prompt.md"
const STATE_CUSTOM_TYPE = "output_style"
const STATUS_ID = "output-style"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

type StylePrompts = Map<string, string>
type ActiveStyle = string | null

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
  let activeStyle: ActiveStyle = null
  let cachedPrompt = ""

  function applyStyle(
    style: ActiveStyle,
    ctx?: { ui: { setStatus: (id: string, text?: string) => void } }
  ) {
    activeStyle = style
    cachedPrompt = style
      ? `\n\nOUTPUT STYLE ACTIVE — ${style}\n\n${prompts.get(style)}`
      : ""
    ctx?.ui.setStatus(STATUS_ID, style ? `✍️ ${style}` : undefined)
  }

  pi.on("session_start", async (_event, ctx) => {
    prompts = loadStylePrompts()

    const entries = ctx.sessionManager.getBranch()
    let restoredStyle: ActiveStyle = null
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as {
        type?: string
        customType?: string
        data?: { style?: unknown }
      }
      if (
        entry.type === "custom" &&
        entry.customType === STATE_CUSTOM_TYPE &&
        (entry.data?.style === null || typeof entry.data?.style === "string")
      ) {
        const savedStyle = entry.data.style
        restoredStyle =
          typeof savedStyle === "string" && prompts.has(savedStyle)
            ? savedStyle
            : null
        break
      }
    }

    applyStyle(restoredStyle, ctx)
  })

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_ID, undefined)
  })

  pi.registerCommand("output-style", {
    description: "Show or set output style: /output-style [off|<style>]",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trim().toLowerCase()
      const names = ["off", ...prompts.keys()]
      const values = names
        .filter((name) => name.startsWith(trimmed))
        .map((name) => ({ value: name, label: name }))
      return values.length > 0 ? values : null
    },
    handler: async (args, ctx) => {
      const requestedStyle = args.trim().toLowerCase()
      if (!requestedStyle) {
        const available = [...prompts.keys()].join(", ")
        ctx.ui.notify(
          `output style: ${activeStyle ?? "off"}. Available: ${available}`,
          "info"
        )
        return
      }

      const nextStyle = requestedStyle === "off" ? null : requestedStyle
      if (nextStyle && !prompts.has(nextStyle)) {
        ctx.ui.notify(`Unknown output style: ${requestedStyle}`, "error")
        return
      }

      applyStyle(nextStyle, ctx)
      pi.appendEntry(STATE_CUSTOM_TYPE, { style: nextStyle })
      ctx.ui.notify(`output style: ${nextStyle ?? "off"}`, "info")
    },
  })

  pi.on("before_agent_start", async (event) => {
    if (!cachedPrompt) return undefined
    return { systemPrompt: `${event.systemPrompt}${cachedPrompt}` }
  })
}
