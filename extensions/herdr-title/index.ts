import net from "node:net"
import path from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const SOURCE = "pi-config:title"
const TOKEN = "title"

function request(socketPath: string, payload: unknown): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath)
    const done = () => {
      socket.destroy()
      resolve()
    }
    socket.setTimeout(1000, done)
    socket.on("error", done)
    socket.on("data", done)
    socket.on("end", done)
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`))
  })
}

/** Reports the session name (no "π - " prefix) as the `$title` herdr sidebar token. */
export default function herdrTitle(pi: ExtensionAPI): void {
  const socketPath = process.env.HERDR_SOCKET_PATH
  const paneId = process.env.HERDR_PANE_ID
  if (process.env.HERDR_ENV !== "1" || !socketPath || !paneId) return

  let seq = Date.now() * 1000
  let last: string | undefined

  function report(value: string | null): Promise<void> {
    seq += 1
    return request(socketPath as string, {
      id: `${SOURCE}:${seq}`,
      method: "pane.report_metadata",
      params: {
        pane_id: paneId,
        source: SOURCE,
        seq,
        tokens: { [TOKEN]: value },
      },
    })
  }

  function update(name: string | undefined, cwd: string): void {
    const next = (name?.trim() || path.basename(cwd)).replace(/\s+/g, " ")
    if (next === last) return
    last = next
    void report(next)
  }

  pi.on("session_start", (_event, ctx) => update(pi.getSessionName(), ctx.cwd))
  pi.on("session_info_changed", (_event, ctx) =>
    update(pi.getSessionName(), ctx.cwd)
  )
  pi.on("session_shutdown", async () => {
    await report(null)
  })
}
