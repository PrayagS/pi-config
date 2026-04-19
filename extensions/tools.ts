/**
 *
 * Tools Extension
 *
 * Provides a /tools command to enable/disable tools interactively.
 * Only disabled tools are tracked — anything not listed is always enabled.
 * State is stored globally in ~/.pi/agent/tools-disabled.json so it
 * persists across all sessions and projects.
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /tools to open the tool selector
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ToolInfo } from "@mariozechner/pi-coding-agent"
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent"
import { Container, type SettingItem, SettingsList } from "@mariozechner/pi-tui"

const CONFIG_DIR = join(homedir(), ".pi", "agent")
const CONFIG_FILE = join(CONFIG_DIR, "tools-disabled.json")

interface GlobalState {
  disabledTools: string[]
}

function loadDisabledTools(): Set<string> {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8")
    const parsed = JSON.parse(raw) as GlobalState
    return new Set(
      Array.isArray(parsed.disabledTools) ? parsed.disabledTools : []
    )
  } catch {
    return new Set()
  }
}

function saveDisabledTools(disabled: Set<string>) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ disabledTools: Array.from(disabled) }, null, 2)
  )
}

export default function toolsExtension(pi: ExtensionAPI) {
  // Only disabled tools are tracked; anything not listed is always enabled
  let disabledTools: Set<string> = loadDisabledTools()
  let allTools: ToolInfo[] = []

  // Apply current tool selection: enable everything except disabled tools
  function applyTools() {
    const active = allTools
      .filter((t) => !disabledTools.has(t.name))
      .map((t) => t.name)
    pi.setActiveTools(active)
  }

  function refreshAndApply() {
    allTools = pi.getAllTools()
    disabledTools = loadDisabledTools()
    applyTools()
  }

  // Register /tools command
  pi.registerCommand("tools", {
    description: "Enable/disable tools",
    handler: async (_args, ctx) => {
      // Refresh tool list and global state
      allTools = pi.getAllTools()
      disabledTools = loadDisabledTools()

      await ctx.ui.custom((tui, theme, _kb, done) => {
        // Build settings items for each tool
        const items: SettingItem[] = allTools.map((tool) => ({
          id: tool.name,
          label: tool.name,
          currentValue: disabledTools.has(tool.name) ? "disabled" : "enabled",
          values: ["enabled", "disabled"],
        }))

        const container = new Container()
        container.addChild(
          new (class {
            render(_width: number) {
              return [theme.fg("accent", theme.bold("Tool Configuration")), ""]
            }
            invalidate() {}
          })()
        )

        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 15),
          getSettingsListTheme(),
          (id, newValue) => {
            // Update disabled set, persist globally, and apply immediately
            if (newValue === "disabled") {
              disabledTools.add(id)
            } else {
              disabledTools.delete(id)
            }
            saveDisabledTools(disabledTools)
            applyTools()
          },
          () => {
            // Close dialog
            done(undefined)
          }
        )

        container.addChild(settingsList)

        const component = {
          render(width: number) {
            return container.render(width)
          },
          invalidate() {
            container.invalidate()
          },
          handleInput(data: string) {
            settingsList.handleInput?.(data)
            tui.requestRender()
          },
        }

        return component
      })
    },
  })

  // Apply global state on session start and navigation
  pi.on("session_start", async () => refreshAndApply())
  pi.on("session_tree", async () => refreshAndApply())
  pi.on("session_fork", async () => refreshAndApply())
}
