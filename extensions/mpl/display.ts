/**
 * Shows charts in the final answer instead of only inside the codemode tool call. The model can only
 * write text, so the answer cites a chart as ![title](pngPath) and pi's TUI draws it. Two prototypes:
 *
 * - "entry": when the run settles, append a TUI-only custom entry per cited chart, drawn with
 *   pi-tui's Image just below the answer. Documented APIs; not sent to the model.
 * - "inline": a Markdown transformer swaps each citation for a Kitty image sequence plus blank
 *   rows, which pi's Markdown passes through unwrapped. Draws the chart where it is cited, but
 *   relies on undocumented Markdown behaviour, and only on Kitty-protocol terminals.
 */

import { readFileSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import {
  allocateImageId,
  Container,
  getCapabilities,
  getPngDimensions,
  Image,
  renderImage,
  Text,
} from "@earendil-works/pi-tui"

export type ChartDisplayMode = "entry" | "inline" | "off"
export const CHART_DISPLAY_MODES: readonly ChartDisplayMode[] = [
  "entry",
  "inline",
  "off",
]
export const CHART_ENTRY_TYPE = "mpl-chart"
/** Widest a chart is drawn, in terminal cells. */
const MAX_WIDTH_CELLS = 100
/** Braille blank: invisible, but not whitespace, so Markdown keeps the row. */
const BLANK = "\u2800"

export interface ChartRef {
  readonly title: string
  readonly path: string
  /** The exact ![title](path) text in the answer. */
  readonly match: string
}

export interface ChartEntryData {
  readonly title: string
  readonly path: string
}

const CHART_REF = /!\[([^\]\n]*)\]\(<?([^)\s>]+\.png)>?\)/g

/** True when path is an absolute .png inside root. Answers may only display charts this tool wrote. */
export function isChartPath(path: string, root: string): boolean {
  if (!isAbsolute(path) || !path.endsWith(".png")) return false
  const rel = relative(resolve(root), resolve(path))
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/** Chart citations in an answer, in order, one per path, limited to PNGs under root. */
export function chartRefs(markdown: string, root: string): ChartRef[] {
  const seen = new Set<string>()
  const refs: ChartRef[] = []
  for (const [match, title, path] of markdown.matchAll(CHART_REF)) {
    if (!isChartPath(path, root) || seen.has(path)) continue
    seen.add(path)
    refs.push({ title, path, match })
  }
  return refs
}

/** The text of an assistant message, or undefined for other roles. */
export function assistantText(message: unknown): string | undefined {
  const m = message as { role?: string; content?: unknown }
  if (m?.role !== "assistant") return undefined
  if (typeof m.content === "string") return m.content
  if (!Array.isArray(m.content)) return undefined
  return m.content
    .filter((b): b is { type: "text"; text: string } => b?.type === "text")
    .map((b) => b.text)
    .join("\n")
}

function readPngBase64(path: string): string | undefined {
  try {
    return readFileSync(path).toString("base64")
  } catch {
    return undefined
  }
}

const drawWidth = (available: number) =>
  Math.max(1, Math.min(available - 2, MAX_WIDTH_CELLS))

/** "entry" mode: a title line and the chart, or a dim note when the file is gone. */
export function renderChartEntry(
  data: ChartEntryData,
  dim: (text: string) => string
): Container {
  const box = new Container()
  const png = readPngBase64(data.path)
  box.addChild(new Text(dim(`${data.title || "chart"} · ${data.path}`), 1, 0))
  if (!png) {
    box.addChild(new Text(dim("(chart file no longer exists)"), 1, 0))
    return box
  }
  box.addChild(
    new Image(
      png,
      "image/png",
      { fallbackColor: dim },
      { maxWidthCells: MAX_WIDTH_CELLS, filename: data.title }
    )
  )
  return box
}

interface CachedChart {
  readonly mtimeMs: number
  readonly imageId: number
  readonly png: string
  readonly blocks: Map<number, string>
}

/**
 * "inline" mode: Markdown that draws a chart in place. The Kitty sequence occupies the first row;
 * hard breaks over invisible blanks reserve the rest, so following text is not drawn over it.
 * Returns undefined when the terminal has no Kitty graphics or the file is unreadable.
 */
export function createInlineChartRenderer() {
  const cache = new Map<string, CachedChart>()
  return function inlineChart(
    path: string,
    availableWidth: number
  ): string | undefined {
    if (getCapabilities().images !== "kitty") return undefined
    let mtimeMs: number
    try {
      mtimeMs = statSync(path).mtimeMs
    } catch {
      return undefined
    }
    let chart = cache.get(path)
    if (!chart || chart.mtimeMs !== mtimeMs) {
      const png = readPngBase64(path)
      if (!png) return undefined
      chart = {
        mtimeMs,
        png,
        imageId: chart?.imageId ?? allocateImageId(),
        blocks: new Map(),
      }
      cache.set(path, chart)
    }
    const width = drawWidth(availableWidth)
    const cached = chart.blocks.get(width)
    if (cached) return cached
    const dims = getPngDimensions(chart.png)
    if (!dims) return undefined
    const image = renderImage(chart.png, dims, {
      maxWidthCells: width,
      imageId: chart.imageId,
      moveCursor: false,
    })
    if (!image) return undefined
    const filler = Array.from({ length: image.rows - 1 }, () => BLANK)
    const block = [image.sequence, ...filler].join("\\\n")
    chart.blocks.set(width, block)
    return block
  }
}

/** Replaces each chart citation with an inline image block in its own paragraph. */
export function inlineCharts(
  markdown: string,
  availableWidth: number,
  root: string,
  inlineChart: (path: string, width: number) => string | undefined
): string {
  let out = markdown
  for (const ref of chartRefs(markdown, root)) {
    const block = inlineChart(ref.path, availableWidth)
    if (block) out = out.replaceAll(ref.match, `\n\n${block}\n\n`)
  }
  return out
}
