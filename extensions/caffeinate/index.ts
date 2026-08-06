import { type ChildProcess, spawn } from "node:child_process"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export type StartSleepInhibitor = () => ChildProcess | undefined

export function startMacSleepInhibitor(): ChildProcess | undefined {
  if (process.platform !== "darwin") return undefined
  return spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], {
    stdio: "ignore",
  })
}

export default function caffeinate(
  pi: ExtensionAPI,
  startInhibitor: StartSleepInhibitor = startMacSleepInhibitor
): void {
  let inhibitor: ChildProcess | undefined

  function stop(): void {
    const child = inhibitor
    inhibitor = undefined
    if (child) child.kill("SIGTERM")
  }

  pi.on("agent_start", () => {
    if (inhibitor) return

    const child = startInhibitor()
    if (!child) return
    inhibitor = child
    child.unref()

    const handleExit = () => {
      if (inhibitor === child) inhibitor = undefined
    }
    child.once("error", handleExit)
    child.once("exit", handleExit)
  })

  pi.on("agent_settled", stop)
  pi.on("session_shutdown", stop)
}
