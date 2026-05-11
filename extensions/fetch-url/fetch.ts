

export type ExtractionStage = "content-negotiation" | "jina-ai" | "firecrawl" | "markdown-new" | "defuddle"

export interface FetchResult {
  title: string
  content: string
  byline: string
  length: number
  url: string
  stage: ExtractionStage
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

async function fetchWithTimeout(url: string, init: RequestInit, ms = 30_000): Promise<Response> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(t)
  }
}

/** Try Jina AI Reader API. */
async function tryJinaReader(url: string): Promise<string | null> {
  const apiKey = process.env.PI_WEB_FETCH_JINA_API_KEY
  if (!apiKey) return null

  try {
    const res = await fetchWithTimeout(
      "https://r.jina.ai/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ url }),
      },
      15_000,
    )
    if (!res.ok) return null
    const json = await res.json()
    const content = json?.data?.content
    return typeof content === "string" ? content.trim() || null : null
  } catch {
    return null
  }
}

/** Try Firecrawl scrape API. */
async function tryFirecrawl(url: string): Promise<string | null> {
  const apiKey = process.env.PI_WEB_FETCH_FIRECRAWL_API_KEY
  if (!apiKey) return null

  try {
    const res = await fetchWithTimeout(
      "https://api.firecrawl.dev/v2/scrape",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url, formats: ["markdown"], onlyCleanContent: true }),
      },
      30_000,
    )
    if (!res.ok) return null
    const json = await res.json()
    const content = json?.data?.markdown
    return typeof content === "string" ? content.trim() || null : null
  } catch {
    return null
  }
}

/** Try markdown.new proxy. */
async function tryMarkdownNew(url: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(`https://markdown.new/${url}`, {}, 15_000)
    if (!res.ok) return null
    const text = await res.text()
    return text.trim() || null
  } catch {
    return null
  }
}

/** Extract title from markdown text. */
function extractTitle(md: string, fallback: string): string {
  const m = md.match(/^#\s+(.+)$/m)
  return m?.[1] || fallback
}

/** Clean up Defuddle markdown output. */
function cleanMarkdown(md: string): string {
  return md
    .replace(/\[([^\]]*?)\]\([^)]*?\)/g, "$1")
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^#+\s*$/gm, "")
    .replace(/^.*(Share|Tweet|Pin|Email|Print)(\s+(this|on|via))?.{0,20}$/gim, "")
    .replace(/^.*(cookie|consent|privacy policy|accept all).*$/gim, "")
    .trim()
}

export async function fetchAndExtract(url: string): Promise<FetchResult> {
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

  // 1. Server returned markdown directly
  if (contentType.includes("markdown") || (!contentType.includes("html") && !contentType.includes("xml"))) {
    const raw = await res.text()
    return {
      title: extractTitle(raw, url),
      content: raw,
      byline: "",
      length: raw.length,
      url,
      stage: "content-negotiation",
    }
  }

  // 2. Try Jina AI Reader API
  const jina = await tryJinaReader(url)
  if (jina) {
    return {
      title: extractTitle(jina, url),
      content: jina,
      byline: "",
      length: jina.length,
      url,
      stage: "jina-ai",
    }
  }

  // 3. Try Firecrawl
  const firecrawl = await tryFirecrawl(url)
  if (firecrawl) {
    return {
      title: extractTitle(firecrawl, url),
      content: firecrawl,
      byline: "",
      length: firecrawl.length,
      url,
      stage: "firecrawl",
    }
  }

  // 4. Try markdown.new proxy
  const mdNew = await tryMarkdownNew(url)
  if (mdNew) {
    return {
      title: extractTitle(mdNew, url),
      content: mdNew,
      byline: "",
      length: mdNew.length,
      url,
      stage: "markdown-new",
    }
  }

  // 5. HTML → Defuddle
  const [{ Defuddle }, { JSDOM }] = await Promise.all([
    import("defuddle/node"),
    import("jsdom"),
  ])
  const html = await res.text()
  const dom = new JSDOM(html, { url })
  const result = await Defuddle(dom.window.document, url, { markdown: true, removeImages: true })

  if (!result.content?.trim()) throw new Error("Could not extract content from this page")

  const markdown = cleanMarkdown(result.content)

  return {
    title: result.title || "",
    content: markdown,
    byline: result.author || "",
    length: result.wordCount || markdown.length,
    url,
    stage: "defuddle",
  }
}
