import { expect, test } from "bun:test"
import type { CustomEditor } from "@mariozechner/pi-coding-agent"
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@mariozechner/pi-tui"
import extension from "./index"

type Factory = (tui: never, theme: never, keys: never) => CustomEditor
type Handler = (event: unknown, ctx: unknown) => void

async function setup() {
  const handlers = new Map<string, Handler>()
  let factory: Factory | undefined
  const identity = (text: string) => text
  extension({
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    getThinkingLevel: () => "high",
    exec: async () => ({ stdout: "main" }),
  } as never)
  handlers.get("session_start")?.(
    {},
    {
      hasUI: true,
      mode: "tui",
      cwd: "/work/project",
      model: { id: "test-model", contextWindow: 200000 },
      getContextUsage: () => ({ percent: 10, contextWindow: 200000 }),
      sessionManager: { getEntries: () => [] },
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
          getThinkingBorderColor: () => identity,
          getBashModeBorderColor: () => identity,
        },
        setEditorComponent: (value: Factory) => {
          factory = value
        },
        setFooter() {},
      },
    }
  )
  await Bun.sleep(10)
  if (!factory) throw new Error("Editor factory was not installed")
  const editor = factory(
    { terminal: { rows: 24, columns: 80 }, requestRender() {} } as never,
    {
      borderColor: identity,
      selectList: {
        selectedPrefix: identity,
        selectedText: identity,
        description: identity,
        scrollInfo: identity,
        noMatch: identity,
      },
    } as never,
    new KeybindingsManager(TUI_KEYBINDINGS) as never
  )
  return editor
}

test("moves the live Vim status into the outer frame without leaking the inner border", async () => {
  const editor = await setup()
  // The public Vim capability and the border decoration it accompanies.
  // Use the real CustomEditor render, not a fake of Pi's layout.
  let status = { mode: "insert", pending: "", label: "INSERT" }
  Object.defineProperty(editor, Symbol.for("pi-vim-editor"), {
    value: { version: 1, status: () => status },
  })
  const target = editor as unknown as {
    renderBottomBorder(width: number, hidden: number): string
  }
  const bottom = target.renderBottomBorder.bind(editor)
  target.renderBottomBorder = (width, hidden) => {
    const raw = bottom(width, hidden)
    return raw.endsWith("─".repeat(12))
      ? `${raw.slice(0, -12)} ${status.label} ─`
      : raw
  }

  for (const next of [
    { mode: "insert", pending: "", label: "INSERT" },
    { mode: "normal", pending: "", label: "NORMAL" },
    { mode: "normal", pending: "2d", label: "2d" },
    { mode: "normal", pending: "/foo", label: "/foo" },
    { mode: "visual-line", pending: "", label: "VISUAL LINE" },
  ]) {
    status = next
    for (const width of [30, 80]) {
      const rows = editor.render(width)
      expect(rows).toHaveLength(5)
      expect(rows.slice(1, -1).some((row) => row.includes("──"))).toBe(false)
      expect(rows.at(-1)).toContain(next.label)
      expect(rows.every((row) => visibleWidth(row) === width)).toBe(true)
    }
  }
  expect(editor.render(12).every((row) => visibleWidth(row) === 12)).toBe(true)
  // Below the boxed layout's cutoff, native borders must still render.
  expect(editor.render(11).join("\n")).not.toContain("body-end")
})

test("preserves rule-like prompt text instead of mistaking it for the bottom border", async () => {
  const editor = await setup()
  editor.setText("first\n────────\nlast")
  const rows = editor.render(80)
  expect(rows[2]).toContain("────────")
  expect(rows[3]).toContain("last")
  expect(rows).toHaveLength(5)
  expect(rows.at(-1)).toContain("/work/project (main)")
})

test("keeps autocomplete below the outer frame", async () => {
  const editor = await setup()
  editor.setAutocompleteProvider({
    getSuggestions: async () => ({
      prefix: "/",
      items: [
        { value: "/first", label: "first-choice" },
        { value: "/second", label: "second-choice" },
      ],
    }),
    applyCompletion: (lines, cursorLine, cursorCol) => ({
      lines,
      cursorLine,
      cursorCol,
    }),
  })
  editor.setText("/")
  editor.handleInput("\t")
  await Bun.sleep(10)
  expect(editor.isShowingAutocomplete()).toBe(true)
  const rows = editor.render(80)
  expect(rows[4]).toContain("╰")
  expect(rows.slice(0, 4).join("\n")).not.toContain("first-choice")
  expect(rows.slice(5).join("\n")).toContain("first-choice")
  expect(rows.join("\n")).not.toContain("body-end")
})
