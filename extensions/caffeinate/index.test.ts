import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import caffeinate, { type StartSleepInhibitor } from "./index"

type Handler = () => void | Promise<void>

class FakeChild extends EventEmitter {
  killSignals: Array<NodeJS.Signals | number | undefined> = []
  unrefCalls = 0

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal)
    return true
  }

  unref(): this {
    this.unrefCalls++
    return this
  }
}

function setup() {
  const handlers = new Map<string, Handler>()
  const children: FakeChild[] = []
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler)
    },
  }
  const startInhibitor: StartSleepInhibitor = () => {
    const child = new FakeChild()
    children.push(child)
    return child as never
  }

  caffeinate(pi as never, startInhibitor)

  return { children, handlers }
}

async function emit(
  handlers: Map<string, Handler>,
  event: string
): Promise<void> {
  await handlers.get(event)?.()
}

describe("caffeinate lifecycle", () => {
  test("holds one inhibitor until the full agent run settles", async () => {
    const { children, handlers } = setup()

    expect(handlers.has("agent_end")).toBe(false)
    await emit(handlers, "agent_start")
    await emit(handlers, "agent_start")

    expect(children).toHaveLength(1)
    expect(children[0]?.unrefCalls).toBe(1)

    await emit(handlers, "agent_settled")

    expect(children[0]?.killSignals).toEqual(["SIGTERM"])
  })

  test("cleans up on shutdown and ignores stale child events", async () => {
    const { children, handlers } = setup()

    await emit(handlers, "agent_start")
    children[0]?.emit("error", new Error("unexpected failure"))
    await emit(handlers, "agent_start")
    expect(children).toHaveLength(2)

    children[0]?.emit("exit", 1, null)
    await emit(handlers, "agent_start")
    expect(children).toHaveLength(2)

    await emit(handlers, "session_shutdown")
    expect(children[1]?.killSignals).toEqual(["SIGTERM"])
  })
})
