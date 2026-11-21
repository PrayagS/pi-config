import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, beforeEach, test } from "node:test"
import { Markdown, setCapabilities } from "@earendil-works/pi-tui"
import {
  assistantText,
  CHART_ENTRY_TYPE,
  chartRefs,
  createInlineChartRenderer,
  inlineCharts,
  isChartPath,
  renderChartEntry,
} from "./display.ts"
import { registerChartDisplay } from "./index.ts"
import { renderChart } from "./render.ts"

const root = mkdtempSync(join(tmpdir(), "pi-mpl-display-"))
after(() => rmSync(root, { recursive: true, force: true }))
mkdirSync(join(root, "day"))
const chart = renderChart(
  {
    name: "c",
    scale: 1,
    calls: [
      [
        "plot",
        [
          [1, 2, 3],
          [3, 1, 2],
        ],
      ],
    ],
  },
  join(root, "day")
).pngPath as string

const kitty = { images: "kitty", trueColor: true, hyperlinks: true } as const
const none = { images: null, trueColor: true, hyperlinks: true } as const
beforeEach(() => setCapabilities(kitty))

const KITTY = "\x1b_G"
const plain = new Proxy(
  {},
  { get: (_, k) => (k === "highlightCode" ? undefined : (s: string) => s) }
)
const renderMarkdown = (md: string, width = 80) =>
  new Markdown(md, 0, 0, plain as never).render(width)

test("only absolute PNGs inside the charts root count", () => {
  assert.ok(isChartPath(chart, root))
  assert.ok(!isChartPath("/etc/passwd.png", root))
  assert.ok(!isChartPath(join(root, "..", "x.png"), root))
  assert.ok(!isChartPath("day/c.png", root))
  assert.ok(!isChartPath(join(root, "day", "c.svg"), root))
})

test("chart refs are found in order, once per path, and others ignored", () => {
  const md = `![A](${chart}) and ![B](/tmp/elsewhere.png)\n![again](<${chart}>)`
  const refs = chartRefs(md, root)
  assert.deepEqual(
    refs.map((r) => [r.title, r.path]),
    [["A", chart]]
  )
})

test("assistant text joins text blocks and skips other roles", () => {
  const msg = {
    role: "assistant",
    content: [
      { type: "text", text: "a" },
      { type: "toolCall" },
      { type: "text", text: "b" },
    ],
  }
  assert.equal(assistantText(msg), "a\nb")
  assert.equal(assistantText({ role: "user", content: "x" }), undefined)
})

test("inline: the image survives Markdown and reserves its rows", () => {
  const md = `Before.\n\n![chart](${chart})\n\nAfter.`
  const out = inlineCharts(md, 80, root, createInlineChartRenderer())
  const lines = renderMarkdown(out)
  const img = lines.findIndex((l) => l.includes(KITTY))
  const afterLine = lines.findIndex((l) => l.includes("After."))
  assert.ok(img > 0, "image line present")
  assert.equal(lines.filter((l) => l.includes(KITTY)).length, 1)
  const rows = Number(/r=(\d+)/.exec(lines[img])?.[1])
  assert.ok(rows > 1, `kitty rows in sequence: ${rows}`)
  assert.ok(
    afterLine - img >= rows,
    `after text at +${afterLine - img}, image ${rows} rows`
  )
})

test("inline: the same chart keeps one image id and reuses blocks per width", () => {
  const inline = createInlineChartRenderer()
  const a = inline(chart, 80)
  assert.equal(inline(chart, 80), a)
  const id = (s?: string) => /i=(\d+)/.exec(s ?? "")?.[1]
  assert.equal(id(inline(chart, 60)), id(a))
})

test("inline: no Kitty graphics or a missing file leaves the Markdown alone", () => {
  const md = `![chart](${chart})`
  setCapabilities(none)
  assert.equal(inlineCharts(md, 80, root, createInlineChartRenderer()), md)
  setCapabilities(kitty)
  const gone = `![gone](${join(root, "day", "gone.png")})`
  assert.equal(inlineCharts(gone, 80, root, createInlineChartRenderer()), gone)
})

test("entry: renders the chart, or a note when the file is gone", () => {
  const ok = renderChartEntry({ title: "t", path: chart }, (s) => s).render(80)
  assert.ok(ok.some((l) => l.includes(KITTY)))
  const gone = renderChartEntry(
    { title: "t", path: join(root, "gone.png") },
    (s) => s
  ).render(80)
  assert.ok(gone.some((l) => l.includes("no longer exists")))
})

/** A fake ExtensionAPI capturing what registerChartDisplay registers. */
function fakePi() {
  const handlers = new Map<string, (event: unknown) => Promise<void>>()
  const entries: unknown[] = []
  const pi = {
    handlers,
    entries,
    transformer: undefined as
      | undefined
      | ((md: string, ctx: unknown) => string),
    command: undefined as
      | undefined
      | { handler: (args: string, ctx: unknown) => Promise<void> },
    on: (name: string, h: (event: unknown) => Promise<void>) =>
      handlers.set(name, h),
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
    registerEntryRenderer: () => {},
    registerCommand: (_: string, c: never) => {
      pi.command = c
    },
    registerMarkdownTransformer: (t: never) => {
      pi.transformer = t
    },
  }
  return pi
}

async function run(
  pi: ReturnType<typeof fakePi>,
  answer: string,
  aborted = false
) {
  await pi.handlers.get("agent_start")?.({})
  await pi.handlers.get("message_end")?.({
    message: { role: "assistant", content: [{ type: "text", text: "draft" }] },
  })
  await pi.handlers.get("message_end")?.({
    message: { role: "toolResult", content: [] },
  })
  await pi.handlers.get("message_end")?.({
    message: { role: "assistant", content: [{ type: "text", text: answer }] },
  })
  await pi.handlers.get("agent_settled")?.({ aborted })
}

test("inline is the default mode", () => {
  const saved = process.env.PI_MPL_CHART_DISPLAY
  delete process.env.PI_MPL_CHART_DISPLAY
  try {
    const pi = fakePi()
    registerChartDisplay(pi as never, root)
    const out = pi.transformer?.(`![c](${chart})`, {
      isStreaming: false,
      availableWidth: 80,
    })
    assert.ok(out?.includes(KITTY))
  } finally {
    if (saved !== undefined) process.env.PI_MPL_CHART_DISPLAY = saved
  }
})

test("entry mode appends one entry per chart cited in the final answer", async () => {
  const pi = fakePi()
  registerChartDisplay(pi as never, root, "entry")
  await run(pi, `Here:\n\n![Latency](${chart})\n\n![x](/tmp/x.png)`)
  assert.deepEqual(pi.entries, [
    { type: CHART_ENTRY_TYPE, data: { title: "Latency", path: chart } },
  ])
  await run(pi, `![Latency](${chart})`, true)
  assert.equal(pi.entries.length, 1, "aborted runs add nothing")
  assert.equal(
    pi.transformer?.(`![c](${chart})`, {
      isStreaming: false,
      availableWidth: 80,
    }),
    `![c](${chart})`
  )
})

test("inline mode transforms finished answers only, and /mpl-display switches modes", async () => {
  const pi = fakePi()
  registerChartDisplay(pi as never, root, "inline")
  const md = `![c](${chart})`
  assert.equal(
    pi.transformer?.(md, { isStreaming: true, availableWidth: 80 }),
    md
  )
  assert.ok(
    pi
      .transformer?.(md, { isStreaming: false, availableWidth: 80 })
      .includes(KITTY)
  )
  await run(pi, md)
  assert.equal(pi.entries.length, 0)
  const notes: string[] = []
  const ctx = { ui: { notify: (m: string) => notes.push(m) } }
  await pi.command?.handler("off", ctx)
  assert.equal(
    pi.transformer?.(md, { isStreaming: false, availableWidth: 80 }),
    md
  )
  await pi.command?.handler("bogus", ctx)
  assert.deepEqual(notes, [
    "mpl chart display: off",
    "mpl-display: expected entry | inline | off",
  ])
})
