import { Socket } from "node:net"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

type SupacodeEnv = {
  socketPath: string
  worktreeId: string
  tabId: string
  surfaceId: string
}

function getSupacodeEnv(): SupacodeEnv | null {
  const socketPath = process.env.SUPACODE_SOCKET_PATH?.trim()
  const worktreeId = process.env.SUPACODE_WORKTREE_ID?.trim()
  const tabId = process.env.SUPACODE_TAB_ID?.trim()
  const surfaceId = process.env.SUPACODE_SURFACE_ID?.trim()

  if (!socketPath || !worktreeId || !tabId || !surfaceId) {
    return null
  }

  return { socketPath, worktreeId, tabId, surfaceId }
}

function createBusyMessage(env: SupacodeEnv, active: boolean): string {
  return `${env.worktreeId} ${env.tabId} ${env.surfaceId} ${active ? "1" : "0"}\n`
}

function createNotificationMessage(
  env: SupacodeEnv,
  payload: {
    hook_event_name: string
    title?: string
    message?: string
    last_assistant_message?: string
  }
): string {
  return `${env.worktreeId} ${env.tabId} ${env.surfaceId} pi\n${JSON.stringify(payload)}\n`
}

async function sendToSupacodeSocket(
  socketPath: string,
  message: string
): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = new Socket()
    let done = false

    const finish = () => {
      if (done) return
      done = true
      socket.destroy()
      resolve()
    }

    socket.setTimeout(1000, finish)
    socket.once("error", finish)
    socket.once("close", finish)
    socket.connect(socketPath, () => {
      socket.end(message)
    })
  })
}

async function sendBusy(active: boolean): Promise<void> {
  const env = getSupacodeEnv()
  if (!env) return
  await sendToSupacodeSocket(env.socketPath, createBusyMessage(env, active))
}

async function sendNotification(lastAssistantMessage?: string): Promise<void> {
  const env = getSupacodeEnv()
  if (!env) return

  const payload = {
    hook_event_name: "Stop",
    last_assistant_message: lastAssistantMessage,
  }

  await sendToSupacodeSocket(
    env.socketPath,
    createNotificationMessage(env, payload)
  )
}

function extractLastAssistantMessage(event: unknown): string | undefined {
  const maybeMessages = (event as { messages?: unknown })?.messages
  if (!Array.isArray(maybeMessages)) return undefined

  for (let i = maybeMessages.length - 1; i >= 0; i -= 1) {
    const message = maybeMessages[i] as { role?: unknown; content?: unknown }
    if (message.role !== "assistant") continue

    const content = message.content
    if (typeof content === "string") {
      const trimmed = content.trim()
      return trimmed.length > 0 ? trimmed : undefined
    }

    if (Array.isArray(content)) {
      const parts = content
        .map((part) => {
          const typedPart = part as { type?: unknown; text?: unknown }
          if (typedPart.type === "text" && typeof typedPart.text === "string") {
            return typedPart.text
          }
          return ""
        })
        .join(" ")
        .trim()
      if (parts.length > 0) return parts
    }
  }

  return undefined
}

export default function supacode(pi: ExtensionAPI) {
  pi.registerCommand("supacode-hook-status", {
    description: "Show whether Supacode hook env vars are available",
    handler: async (_args, ctx) => {
      const env = getSupacodeEnv()
      if (!env) {
        ctx.ui.notify(
          "Supacode hook env vars not found in this terminal.",
          "info"
        )
        return
      }
      ctx.ui.notify(
        `Supacode hook active (socket: ${env.socketPath}, tab: ${env.tabId.slice(0, 8)}…).`,
        "success"
      )
    },
  })

  pi.on("agent_start", async () => {
    await sendBusy(true)
  })

  pi.on("agent_end", async (event) => {
    await sendBusy(false)
    await sendNotification(extractLastAssistantMessage(event))
  })

  pi.on("session_shutdown", async () => {
    await sendBusy(false)
  })
}
