

export type ExtractionStage = "content-negotiation" | "jina-ai" | "firecrawl" | "parallel" | "tavily" | "exa" | "you" | "markdown-new" | "defuddle"

function shouldRunStage(stage: ExtractionStage): boolean {
  const envStage = process.env.PI_FETCH_URL_STAGE
  return !envStage || envStage === stage
}

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
async function tryFirecrawl(url: string): Promise<{ markdown: string; metadata: Record<string, unknown> } | null> {
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
        body: JSON.stringify({ url, formats: ["markdown"] }),
      },
      30_000,
    )
    if (!res.ok) return null
    const json = await res.json()
    const data = json?.data
    const content = data?.markdown
    if (typeof content !== "string") return null
    const meta = data?.metadata
    const metadata: Record<string, unknown> = {}
    if (meta?.title) metadata.title = meta.title
    if (meta?.cacheState) metadata.cacheState = meta.cacheState
    if (meta?.cachedAt) metadata.cachedAt = meta.cachedAt
    return { markdown: content.trim() || "", metadata }
  } catch {
    return null
  }
}

/** Try Parallel Extract API. */
async function tryParallel(url: string): Promise<{ markdown: string; title?: string } | null> {
  const apiKey = process.env.PI_WEB_FETCH_PARALLEL_API_KEY
  if (!apiKey) return null

  try {
    const res = await fetchWithTimeout(
      "https://api.parallel.ai/v1/extract",
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ urls: [url], advanced_settings: { full_content: true } }),
      },
      30_000,
    )
    if (!res.ok) return null
    const json = await res.json()
    const result = json?.results?.[0]
    const content = result?.full_content || (Array.isArray(result?.excerpts) ? result.excerpts.join("\n\n") : null)
    if (typeof content !== "string") return null
    return { markdown: content.trim() || "", title: result?.title }
  } catch {
    return null
  }
}

/** Try Tavily extract API. */
async function tryTavily(url: string): Promise<string | null> {
  const apiKey = process.env.PI_WEB_FETCH_TAVILY_API_KEY
  if (!apiKey) return null

  try {
    const res = await fetchWithTimeout(
      "https://api.tavily.com/extract",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ urls: [url], extract_depth: "advanced" }),
      },
      30_000,
    )
    if (!res.ok) return null
    const json = await res.json()
    const result = json?.results?.[0]
    const content = result?.raw_content
    return typeof content === "string" ? content.trim() || null : null
  } catch {
    return null
  }
}

/** Try Exa.ai contents API. */
async function tryExa(url: string): Promise<{ text: string; title?: string } | null> {
  const apiKey = process.env.PI_WEB_FETCH_EXA_API_KEY
  if (!apiKey) return null

  try {
    const res = await fetchWithTimeout(
      "https://api.exa.ai/contents",
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ids: [url], text: { verbosity: "full" } }),
      },
      30_000,
    )
    if (!res.ok) return null
    const json = await res.json()
    const result = json?.results?.[0]
    const content = result?.text
    if (typeof content !== "string") return null
    return { text: content.trim() || "", title: result?.title }
  } catch {
    return null
  }
}

/** Try You.com Contents API. */
async function tryYou(url: string): Promise<{ markdown: string; title?: string } | null> {
  const apiKey = process.env.PI_WEB_FETCH_YOU_API_KEY
  if (!apiKey) return null

  try {
    const res = await fetchWithTimeout(
      "https://ydc-index.io/v1/contents",
      {
        method: "POST",
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ urls: [url], formats: ["markdown"], crawl_timeout: 10 }),
      },
      30_000,
    )
    if (!res.ok) return null
    const json = await res.json()
    const item = Array.isArray(json) ? json[0] : null
    const content = item?.markdown
    if (typeof content !== "string") return null
    return { markdown: content.trim() || "", title: item?.title }
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
  const envStage = process.env.PI_FETCH_URL_STAGE

  // When a specific stage is requested, skip direct fetch and run only that stage
  if (envStage) {
    switch (envStage) {
      case "jina-ai": {
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
        break
      }
      case "firecrawl": {
        const firecrawl = await tryFirecrawl(url)
        if (firecrawl) {
          return {
            title: extractTitle(firecrawl.markdown, url),
            content: firecrawl.markdown,
            byline: "",
            length: firecrawl.markdown.length,
            url,
            stage: "firecrawl",
            metadata: firecrawl.metadata,
          }
        }
        break
      }
      case "parallel": {
        const parallel = await tryParallel(url)
        if (parallel) {
          return {
            title: parallel.title || extractTitle(parallel.markdown, url),
            content: parallel.markdown,
            byline: "",
            length: parallel.markdown.length,
            url,
            stage: "parallel",
          }
        }
        break
      }
      case "tavily": {
        const tavily = await tryTavily(url)
        if (tavily) {
          return {
            title: extractTitle(tavily, url),
            content: tavily,
            byline: "",
            length: tavily.length,
            url,
            stage: "tavily",
          }
        }
        break
      }
      case "exa": {
        const exa = await tryExa(url)
        if (exa) {
          return {
            title: exa.title || extractTitle(exa.text, url),
            content: exa.text,
            byline: "",
            length: exa.text.length,
            url,
            stage: "exa",
          }
        }
        break
      }
      case "you": {
        const you = await tryYou(url)
        if (you) {
          return {
            title: you.title || extractTitle(you.markdown, url),
            content: you.markdown,
            byline: "",
            length: you.markdown.length,
            url,
            stage: "you",
          }
        }
        break
      }
      case "markdown-new": {
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
        break
      }
      case "defuddle":
      case "content-negotiation": {
        // Fall through to normal pipeline below
        break
      }
      default: {
        throw new Error(`Unknown stage "${envStage}"`)
      }
    }
  }

  // Normal pipeline: direct fetch first, then fallbacks
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
      title: extractTitle(firecrawl.markdown, url),
      content: firecrawl.markdown,
      byline: "",
      length: firecrawl.markdown.length,
      url,
      stage: "firecrawl",
      metadata: firecrawl.metadata,
    }
  }

  // 4. Try Parallel
  const parallel = await tryParallel(url)
  if (parallel) {
    return {
      title: parallel.title || extractTitle(parallel.markdown, url),
      content: parallel.markdown,
      byline: "",
      length: parallel.markdown.length,
      url,
      stage: "parallel",
    }
  }

  // 5. Try Tavily
  const tavily = await tryTavily(url)
  if (tavily) {
    return {
      title: extractTitle(tavily, url),
      content: tavily,
      byline: "",
      length: tavily.length,
      url,
      stage: "tavily",
    }
  }

  // 6. Try Exa
  const exa = await tryExa(url)
  if (exa) {
    return {
      title: exa.title || extractTitle(exa.text, url),
      content: exa.text,
      byline: "",
      length: exa.text.length,
      url,
      stage: "exa",
    }
  }

  // 7. Try You.com
  const you = await tryYou(url)
  if (you) {
    return {
      title: you.title || extractTitle(you.markdown, url),
      content: you.markdown,
      byline: "",
      length: you.markdown.length,
      url,
      stage: "you",
    }
  }

  // 7. Try markdown.new proxy
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

  // 8. HTML → Defuddle
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
