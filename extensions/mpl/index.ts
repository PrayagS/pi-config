/**
 * mpl_render: a codemode tool that draws matplotlib-style charts with mpl (github.com/ivarvong/mpl)
 * from a JSON call list, writes PNG/SVG files, and returns the PNG so a script can show it with image().
 */

import { Worker } from "node:worker_threads"
import type {
  ExtensionAPI,
  ToolDefinition,
  ToolNamespace,
} from "@earendil-works/pi-coding-agent"
import { type TSchema, Type } from "typebox"
import {
  MPL_APPEARANCE_THEMES,
  MPL_CHARTS_ROOT,
  MPL_DEFAULT_THEME,
  MPL_FIGURE_METHOD_NAMES,
} from "./constants.ts"
import {
  assistantText,
  CHART_DISPLAY_MODES,
  CHART_ENTRY_TYPE,
  type ChartDisplayMode,
  type ChartEntryData,
  chartRefs,
  createInlineChartRenderer,
  inlineCharts,
  renderChartEntry,
} from "./display.ts"
import {
  checkSpecLimits,
  MPL_MAX_AXES,
  MPL_MAX_VALUES,
  MPL_RENDER_TIMEOUT_MS,
} from "./limits.ts"
import type { MplRenderInput, MplRenderOutput } from "./render.ts"
import type { MplWorkerRequest } from "./worker.ts"

const MPL_RENDER_TOOL_NAME = "mpl_render"

/**
 * Renders in a fresh worker thread, so mpl loads only when a chart is drawn, pi stays responsive
 * during the render, and an abort or the timeout terminates it.
 */
export function renderInWorker(
  input: MplRenderInput,
  outDir?: string,
  signal?: AbortSignal,
  timeoutMs = MPL_RENDER_TIMEOUT_MS
): Promise<MplRenderOutput> {
  checkSpecLimits(input)
  if (signal?.aborted) return Promise.reject(new Error("render cancelled"))
  return new Promise((resolve, reject) => {
    const request: MplWorkerRequest = { input, outDir }
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      workerData: request,
    })
    let settled = false
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      void worker.terminate()
      settle()
    }
    const onAbort = () => finish(() => reject(new Error("render cancelled")))
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `render took longer than ${timeoutMs / 1000} s and was stopped; downsample the data or lower scale`
            )
          )
        ),
      timeoutMs
    )
    signal?.addEventListener("abort", onAbort, { once: true })
    worker.once("message", (m: { out?: MplRenderOutput; error?: string }) =>
      finish(() =>
        m.out ? resolve(m.out) : reject(new Error(m.error ?? "render failed"))
      )
    )
    worker.once("error", (error) => finish(() => reject(error)))
    worker.once("exit", (code) =>
      finish(() => reject(new Error(`render worker exited with code ${code}`)))
    )
  })
}

export const mplInstructions = `Reference for mpl_render. mpl is a pixel-exact TypeScript port of matplotlib 3.11: calls follow matplotlib's object API (ax.<method>(*args, **kwargs)), kwargs and rc keys included.

Spec: { calls, theme?, rc?, grid?, format?, scale?, name?, tight_layout? }
- calls: [method, [positional args], {kwargs}], applied in order to the current Axes. ax.plot(x, y, 'o-', label='a') is ["plot", [x, y, "o-"], { label: "a" }].
- grid: { rows, cols, sharex?, sharey?, width_ratios?, height_ratios? }. Axes are numbered row-major from 0; ["sca", [i]] makes Axes i current; ["twinx", []] adds a twin and makes it current.
- Figure calls take a "fig." prefix: ${MPL_FIGURE_METHOD_NAMES.map((m) => `fig.${m}`).join(", ")}. fig.colorbar maps the last imshow or colour-mapped scatter on the current Axes.
- Values: {"$float": "nan"} is NaN. Kwarg {"$transform": "axes"} is ax.transAxes.
- theme: omit it to match pi's appearance ("${MPL_APPEARANCE_THEMES.dark}" or "${MPL_APPEARANCE_THEMES.light}"). Others: "pro-slate", "pro-dark", or any matplotlib style name. rc overrides keys, e.g. { "figure.figsize": [9, 4] }.
- scale: PNG pixel multiplier from 0.25 to 4, default 2 (1440x840 at the default size); 3 for print.
- format: "png" (default), "svg", or "both". Files land in ~/.pi/agent/work/charts/<date>/; tight_layout runs unless the calls lay out the figure.

Dates:
- {"$dates": ["2026-01-01", ...]} is Date[], {"$date": "..."} one Date; naive ISO strings are UTC. plot, bar, text, axvline and fill_between take them.
- Ticks: ["$concise_x", []] for ConciseDateFormatter, or ["$date_x", ["MonthLocator", { interval: 1 }, "%b %d" | "concise"]].
- annotate takes epoch days (ms / 86400000) as coordinates.

Colours (Gruvbox): cycle C0..C6 = blue, orange, green, red, purple, aqua, yellow in both themes. Refer to colours as "C0".."C6" so a chart reads well in either appearance; use "C3" for bad/alerts and "C2" for good.

Chart types: line, step, scatter, bar/barh (bottom/left for stacks), hist, boxplot, errorbar, fill_between, imshow + fig.colorbar, axhline/axvline/axhspan/axvspan, text, annotate. For shares use barh; for distributions use hist or boxplot; for legend placement use loc and ncols.

Gotchas:
- Unknown kwargs and rc keys throw, as in matplotlib; the error names the call index and the offending key.
- Scatter legend: label a proxy ["plot", [[], [], "o"], { color: "C0", label: "name" }] rather than the scatter.
- Text: Latin, Greek, arrows and math symbols; use ASCII for tree labels and ~ for approximations.
- Keep each series under ~100k points. Limits: at most ${MPL_MAX_AXES} Axes per grid, ${MPL_MAX_VALUES.toLocaleString("en-US")} values per spec, and ${MPL_RENDER_TIMEOUT_MS / 1000} s per render.

Showing a chart to the user: image(r.image) is for you to check the chart; the user only sees it if they expand the tool call. To show the final chart, put ![short title](<r.pngPath>) on its own line in your final answer, with the pngPath exactly as returned. pi draws each cited chart. Cite only final versions, not drafts.

Done when: the image you showed has no overlapping or clipped labels, no legend covering data, and readable ticks; otherwise adjust (figsize, ticks, legend loc, ylim headroom) and re-render.`

export const mplToolNamespace: ToolNamespace = {
  name: "mpl",
  instructions: mplInstructions,
}

export const mplRenderParameters = Type.Object({
  calls: Type.Array(Type.Array(Type.Unknown(), { minItems: 1, maxItems: 3 }), {
    description:
      '[method, [positional args], {kwargs}], e.g. ["bar", [names, values], { color: "C1" }]',
  }),
  theme: Type.Optional(
    Type.String({
      description: `default: ${MPL_APPEARANCE_THEMES.dark} or ${MPL_APPEARANCE_THEMES.light}, following pi's appearance`,
    })
  ),
  rc: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  grid: Type.Optional(
    Type.Object({
      rows: Type.Integer(),
      cols: Type.Integer(),
      sharex: Type.Optional(Type.Union([Type.Boolean(), Type.String()])),
      sharey: Type.Optional(Type.Union([Type.Boolean(), Type.String()])),
      width_ratios: Type.Optional(Type.Array(Type.Number())),
      height_ratios: Type.Optional(Type.Array(Type.Number())),
    })
  ),
  format: Type.Optional(
    Type.Union([Type.Literal("png"), Type.Literal("svg"), Type.Literal("both")])
  ),
  scale: Type.Optional(Type.Number()),
  name: Type.Optional(Type.String()),
  tight_layout: Type.Optional(Type.Boolean()),
})

export const mplRenderOutput = Type.Object({
  image: Type.Optional(
    Type.Object({
      type: Type.Literal("image"),
      data: Type.String(),
      mimeType: Type.String(),
    })
  ),
  pngPath: Type.Optional(Type.String()),
  svgPath: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
})

export function toMplRenderToolDefinition(
  outDir?: () => string,
  timeoutMs?: number
): ToolDefinition<TSchema, undefined> {
  return {
    name: MPL_RENDER_TOOL_NAME,
    label: "mpl render",
    description:
      'Chart data as PNG/SVG through the matplotlib API. Read describeNamespace("mpl") before the first chart; check the result with image(r.image); cite ![title](pngPath) in your final answer to show it to the user.',
    parameters: mplRenderParameters as unknown as TSchema,
    outputSchema: mplRenderOutput as unknown as TSchema,
    exposure: "codemode",
    namespace: mplToolNamespace,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const spec = params as MplRenderInput
      const input = { ...spec, theme: spec.theme ?? defaultTheme(ctx) }
      try {
        const out = await renderInWorker(input, outDir?.(), signal, timeoutMs)
        const image = out.png
          ? {
              type: "image" as const,
              data: Buffer.from(out.png).toString("base64"),
              mimeType: "image/png" as const,
            }
          : undefined
        const structured = {
          ...(image && { image }),
          ...(out.pngPath && { pngPath: out.pngPath }),
          ...(out.svgPath && { svgPath: out.svgPath }),
        }
        const paths = [out.pngPath, out.svgPath].filter(Boolean).join("\n")
        return {
          content: [
            ...(image ? [image] : []),
            { type: "text" as const, text: paths },
          ],
          structuredContent: structured as never,
          details: undefined,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [
            { type: "text" as const, text: `mpl_render failed: ${message}` },
          ],
          structuredContent: { error: message } as never,
          details: undefined,
          isError: true,
        }
      }
    },
  }
}

/** The theme matching pi's light/dark appearance, or the dark default without a UI. */
export function defaultTheme(ctx?: {
  hasUI?: boolean
  ui?: { theme?: { appearance?: string } }
}): string {
  const appearance = ctx?.hasUI ? ctx.ui?.theme?.appearance : undefined
  return appearance === "light"
    ? MPL_APPEARANCE_THEMES.light
    : MPL_DEFAULT_THEME
}

function initialDisplayMode(): ChartDisplayMode {
  const fromEnv = process.env.PI_MPL_CHART_DISPLAY as ChartDisplayMode
  return CHART_DISPLAY_MODES.includes(fromEnv) ? fromEnv : "inline"
}

export default function mplExtension(pi: ExtensionAPI): void {
  pi.registerTool(toMplRenderToolDefinition())
  registerChartDisplay(pi)
}

/** Shows charts cited in the final answer (see display.ts). Spike: switch modes with /mpl-display. */
export function registerChartDisplay(
  pi: ExtensionAPI,
  root = MPL_CHARTS_ROOT,
  initialMode = initialDisplayMode()
): void {
  let mode = initialMode
  let lastAnswer: string | undefined

  pi.registerCommand("mpl-display", {
    description: "How cited charts are shown: inline | entry | off",
    getArgumentCompletions: (prefix) =>
      CHART_DISPLAY_MODES.filter((m) => m.startsWith(prefix.trim())).map(
        (m) => ({ value: m, label: m })
      ),
    handler: async (args, ctx) => {
      const next = args.trim() as ChartDisplayMode
      if (next && !CHART_DISPLAY_MODES.includes(next)) {
        ctx.ui.notify(
          `mpl-display: expected ${CHART_DISPLAY_MODES.join(" | ")}`,
          "error"
        )
        return
      }
      if (next) mode = next
      ctx.ui.notify(`mpl chart display: ${mode}`, "info")
    },
  })

  pi.on("agent_start", async () => {
    lastAnswer = undefined
  })
  pi.on("message_end", async (event) => {
    const text = assistantText(event.message)
    if (text !== undefined) lastAnswer = text
  })
  pi.on("agent_settled", async (event) => {
    const answer = lastAnswer
    lastAnswer = undefined
    if (event.aborted || mode !== "entry" || !answer) return
    for (const { title, path } of chartRefs(answer, root))
      pi.appendEntry<ChartEntryData>(CHART_ENTRY_TYPE, { title, path })
  })
  pi.registerEntryRenderer<ChartEntryData>(
    CHART_ENTRY_TYPE,
    (entry, _options, theme) =>
      entry.data
        ? renderChartEntry(entry.data, (s) => theme.fg("dim", s))
        : undefined
  )

  const inlineChart = createInlineChartRenderer()
  pi.registerMarkdownTransformer(
    (markdown, { isStreaming, availableWidth }) =>
      mode !== "inline" || isStreaming
        ? markdown
        : inlineCharts(markdown, availableWidth, root, inlineChart),
    { messageTypes: ["assistant"] }
  )
}
