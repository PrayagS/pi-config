import { fetchWithTimeout } from "./extractors/http"
import { apiExtractors } from "./extractors"
import type { ExtractResult } from "./extractors"

export type ExtractionStage =
  | "content-negotiation"
  | "jina-ai"
  | "firecrawl"
  | "parallel"
  | "tavily"
  | "exa"
  | "you"
  | "markdown-new"
  | "defuddle"

export interface FetchResult {
  title: string
  content: string
  byline: string
  length: number
  url: string
  stage: ExtractionStage
  metadata?: Record<string, unknown>
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

/** Extract title from markdown text. */
function extractTitle(md: string, fallback: string): string {
  const m = md.match(/^#\s+(.+)$/m)
  return m?.[1] || fallback
}

/** Clean up Defuddle markdown output. */
function cleanMarkdown(md: string): string {
  return md
    .replace(/\[([^\]]*?)\]\([^)]*?\)/g, "$1")
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^#+\s*$/gm, "")
    .replace(
      /^.*(Share|Tweet|Pin|Email|Print)(\s+(this|on|via))?.{0,20}$/gim,
      ""
    )
    .replace(/^.*(cookie|consent|privacy policy|accept all).*$/gim, "")
    .trim()
}

function buildResult(
  url: string,
  extracted: ExtractResult,
  stage: string
): FetchResult {
  const title = extracted.title || extractTitle(extracted.markdown, url)
  return {
    title,
    content: extracted.markdown,
    byline: extracted.byline || "",
    length: extracted.markdown.length,
    url,
    stage: stage as ExtractionStage,
    metadata: extracted.metadata,
  }
}

export async function fetchAndExtract(url: string): Promise<FetchResult> {
  const envStage = process.env.PI_WEB_FETCH_STAGE

  // envStage bypass: run only the named stage
  if (envStage) {
    if (envStage === "content-negotiation" || envStage === "defuddle") {
      // fall through to normal pipeline
    } else {
      const ext = apiExtractors.find((e) => e.name === envStage)
      if (ext) {
        const result = await ext.extract(url)
        if (result) return buildResult(url, result, envStage)
        throw new Error(`Extractor "${envStage}" returned no content`)
      }
      throw new Error(`Unknown stage "${envStage}"`)
    }
  }

  // Normal pipeline: direct fetch → extractors → defuddle
  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": UA,
      Accept:
        "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, application/xml;q=0.8, */*;q=0.1",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  })

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)

  const contentType = res.headers.get("content-type") || ""

  // Content negotiation — server returned markdown directly
  if (
    contentType.includes("markdown") ||
    (!contentType.includes("html") && !contentType.includes("xml"))
  ) {
    const raw = await res.text()
    return buildResult(url, { markdown: raw }, "content-negotiation")
  }

  // Try API extractors in priority order
  for (const ext of apiExtractors) {
    const result = await ext.extract(url)
    if (result) return buildResult(url, result, ext.name)
  }

  // Fallback: Defuddle HTML extraction
  const [{ Defuddle }, { JSDOM }] = await Promise.all([
    import("defuddle/node"),
    import("jsdom"),
  ])
  const html = await res.text()
  const dom = new JSDOM(html, { url })
  const defResult = await Defuddle(dom.window.document, url, {
    markdown: true,
    removeImages: true,
  })

  if (!defResult.content?.trim())
    throw new Error("Could not extract content from this page")

  const markdown = cleanMarkdown(defResult.content)

  return {
    title: defResult.title || "",
    content: markdown,
    byline: defResult.author || "",
    length: defResult.wordCount || markdown.length,
    url,
    stage: "defuddle",
  }
}
