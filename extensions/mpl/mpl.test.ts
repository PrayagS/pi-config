import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { MPL_FIGURE_METHOD_NAMES } from "./constants.ts"
import {
  defaultTheme,
  renderInWorker,
  toMplRenderToolDefinition,
} from "./index.ts"
import { localDate, localTime, MPL_THEMES, renderChart } from "./render.ts"
import { decodeValue, MPL_AXES_METHODS, MPL_FIGURE_METHODS } from "./replay.ts"

test("loading the extension does not load mpl", () => {
  const script = `
    import { registerHooks } from "node:module"
    const seen = []
    registerHooks({ resolve(s, c, next) { if (/^mpl(\\/|$)/.test(s)) seen.push(s); return next(s, c) } })
    const ext = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)})
    ext.default(new Proxy({}, { get: () => () => {} }))
    console.log(JSON.stringify(seen))`
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      encoding: "utf8",
    }
  )
  assert.deepEqual(JSON.parse(out), [])
})

test("every Figure method named in the instructions exists on Figure", () => {
  assert.deepEqual([...MPL_FIGURE_METHODS], [...MPL_FIGURE_METHOD_NAMES])
})

const outDir = mkdtempSync(join(tmpdir(), "pi-mpl-test-"))
after(() => rmSync(outDir, { recursive: true, force: true }))

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

test("the themes include gruvbox, pro-slate and pro-dark", () => {
  for (const t of ["gruvbox-dark", "gruvbox-light", "pro-slate", "pro-dark"])
    assert.ok(MPL_THEMES.includes(t), t)
  assert.ok(!MPL_THEMES.includes("catppuccin-macchiato"))
})

test("Axes allow-list has drawing methods and no private names", () => {
  for (const m of [
    "plot",
    "bar",
    "scatter",
    "hist",
    "set_title",
    "legend",
    "imshow",
  ])
    assert.ok(MPL_AXES_METHODS.has(m), m)
  assert.ok(
    ![...MPL_AXES_METHODS].some((m) => m.startsWith("_") || m === "constructor")
  )
})

test("decodeValue turns $dates, $date and $float into values", () => {
  const [d] = decodeValue({ $dates: ["2026-01-02"] }) as Date[]
  assert.equal(d?.toISOString(), "2026-01-02T00:00:00.000Z")
  assert.equal(
    (decodeValue({ $date: "2026-01-02T03:04:05+01:00" }) as Date).toISOString(),
    "2026-01-02T02:04:05.000Z"
  )
  assert.ok(Number.isNaN(decodeValue({ $float: "nan" })))
})

for (const theme of [
  "gruvbox-dark",
  "gruvbox-light",
  "pro-slate",
  "pro-dark",
]) {
  test(`renders a grid with dates in ${theme}`, () => {
    const days = ["2026-10-01", "2026-10-02", "2026-10-03"]
    const out = renderChart(
      {
        theme,
        name: theme,
        format: "both",
        grid: { rows: 1, cols: 2, width_ratios: [2, 1] },
        calls: [
          ["plot", [{ $dates: days }, [1, 3, 2]], { label: "a" }],
          ["$concise_x", []],
          ["legend", []],
          ["sca", [1]],
          [
            "bar",
            [
              ["x", "y"],
              [2, 1],
            ],
          ],
          ["fig.suptitle", ["t"]],
        ],
      },
      outDir
    )
    assert.deepEqual([...(out.png ?? []).slice(0, 4)], PNG_MAGIC)
    assert.equal(out.width, 1440)
    assert.equal(out.height, 840)
    assert.ok(out.pngPath && existsSync(out.pngPath))
    assert.ok(out.svgPath && readFileSync(out.svgPath, "utf8").includes("<svg"))
  })
}

test("renders with the same name in the same second do not overwrite each other", () => {
  const spec = {
    name: "same",
    format: "both" as const,
    calls: [
      [
        "plot",
        [
          [1, 2],
          [2, 1],
        ],
      ],
    ] as const,
  }
  const a = renderChart(spec, outDir)
  const b = renderChart(spec, outDir)
  assert.notEqual(a.pngPath, b.pngPath)
  assert.notEqual(a.svgPath, b.svgPath)
})

test("unknown methods and kwargs are reported with the call index", () => {
  assert.throws(
    () =>
      renderChart(
        {
          calls: [
            ["plot", [[1], [1]]],
            ["pie", [[1]]],
          ],
        },
        outDir
      ),
    /calls\[1\] pie: unknown call/
  )
  assert.throws(
    () =>
      renderChart({ calls: [["plot", [[1], [1]], { colour: "red" }]] }, outDir),
    /calls\[0\] plot: .*colour/
  )
  assert.throws(
    () => renderChart({ theme: "nope", calls: [] }, outDir),
    /unknown theme/
  )
  assert.throws(
    () => renderChart({ scale: 10, calls: [] }, outDir),
    /scale must be between/
  )
  const unwrapped = ["bar", ["a", "b"], [3, 7]] as never
  assert.throws(
    () => renderChart({ calls: [unwrapped] }, outDir),
    /wrap all positional args in one array/
  )
})

test("the tool returns the PNG as an image block in structuredContent", async () => {
  const tool = toMplRenderToolDefinition(() => outDir)
  const result = await tool.execute(
    "id",
    {
      calls: [
        [
          "plot",
          [
            [1, 2, 3],
            [3, 1, 2],
          ],
        ],
      ],
    } as never,
    undefined,
    undefined,
    undefined as never
  )
  const sc = result.structuredContent as {
    image?: { type: string; data: string }
    pngPath?: string
  }
  assert.equal(sc.image?.type, "image")
  assert.deepEqual(
    [...Buffer.from(sc.image?.data ?? "", "base64").subarray(0, 4)],
    PNG_MAGIC
  )
  assert.ok(sc.pngPath?.startsWith(outDir))

  const failed = await tool.execute(
    "id",
    { calls: [["nope", []]] } as never,
    undefined,
    undefined,
    undefined as never
  )
  assert.equal(failed.isError, true)
  assert.match(
    (failed.structuredContent as { error: string }).error,
    /unknown call/
  )
})

const bigLine = (n: number) => ({
  calls: [
    [
      "plot",
      [
        Array.from({ length: n }, (_, i) => i),
        Array.from({ length: n }, (_, i) => Math.sin(i)),
      ],
    ] as const,
  ],
})

test("a render that outlives the timeout is terminated", async () => {
  const started = performance.now()
  await assert.rejects(
    renderInWorker(bigLine(300_000), outDir, undefined, 300),
    /longer than 0.3 s/
  )
  assert.ok(performance.now() - started < 2000)
})

test("aborting stops a running render", async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 300)
  const started = performance.now()
  await assert.rejects(
    renderInWorker(bigLine(300_000), outDir, controller.signal),
    /cancelled/
  )
  assert.ok(performance.now() - started < 2000)
})

test("oversized specs fail before rendering", async () => {
  const tool = toMplRenderToolDefinition(() => outDir)
  const run = (spec: unknown) =>
    tool.execute("id", spec as never, undefined, undefined, undefined as never)
  const grid = await run({ grid: { rows: 9, cols: 9 }, calls: [] })
  assert.match((grid.structuredContent as { error: string }).error, /81 Axes/)
  const values = await run(bigLine(600_000))
  assert.match(
    (values.structuredContent as { error: string }).error,
    /more than 1,000,000 values/
  )
  assert.throws(() => renderChart(bigLine(600_000), outDir), /values/)
})

test("the default theme follows pi's appearance", () => {
  const ui = (appearance: string) => ({
    hasUI: true,
    ui: { theme: { appearance } },
  })
  assert.equal(defaultTheme(ui("dark")), "gruvbox-dark")
  assert.equal(defaultTheme(ui("light")), "gruvbox-light")
  assert.equal(
    defaultTheme({ hasUI: false, ui: { theme: { appearance: "light" } } }),
    "gruvbox-dark"
  )
  assert.equal(defaultTheme(undefined), "gruvbox-dark")
})

test("the tool renders a spec without a theme in pi's appearance", async () => {
  const tool = toMplRenderToolDefinition(() => outDir)
  const svgBackground = async (appearance: string, theme?: string) => {
    const r = await tool.execute(
      "id",
      {
        format: "svg",
        theme,
        calls: [
          [
            "plot",
            [
              [1, 2],
              [2, 1],
            ],
          ],
        ],
      } as never,
      undefined,
      undefined,
      { hasUI: true, ui: { theme: { appearance } } } as never
    )
    return readFileSync(
      (r.structuredContent as { svgPath: string }).svgPath,
      "utf8"
    )
  }
  assert.match(await svgBackground("light"), /#fbf1c7/i)
  assert.match(await svgBackground("dark"), /#282828/i)
  assert.match(await svgBackground("light", "gruvbox-dark"), /#282828/i)
})

test("chart folders and file stems use local time", () => {
  const now = new Date(2026, 0, 2, 3, 4, 5, 6)
  assert.equal(localDate(now), "2026-01-02")
  assert.equal(localTime(now), "030405006")
})
