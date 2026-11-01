import { fetchMarkdownViaContentNegotiation } from "./content-negotiation"
import { defuddle } from "./defuddle"
import { apiExtractors, firecrawl, jina, you } from "./extractors"
import type { Extractor } from "./extractors"
import { buildResult } from "./result"
import type { FetchResult } from "./result"

export type { ExtractionStage, FetchResult } from "./result"

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Try extractors in order and return the first result. Failures are recorded as
 * "name: reason" so the final result (or error) can say why each one was skipped.
 */
async function firstExtracted(
  url: string,
  extractors: Extractor[],
  rawHtml: boolean,
  errors: string[],
  signal?: AbortSignal,
  sessionKey?: string
): Promise<FetchResult | null> {
  for (const extractor of extractors) {
    if (signal?.aborted) throw new Error("cancelled")
    try {
      const result = await extractor.extract(url, signal, { rawHtml, sessionKey })
      if (result) return buildResult(url, result, extractor.name, rawHtml)
    } catch (error) {
      if (signal?.aborted) throw error
      errors.push(`${extractor.name}: ${errorMessage(error)}`)
    }
  }
  return null
}

/** Run the last-resort local extraction, keeping provider errors in the result. */
async function finalFallback(
  url: string,
  markdown: boolean,
  errors: string[],
  signal?: AbortSignal
): Promise<FetchResult> {
  try {
    const result = await defuddle(url, markdown, signal)
    return errors.length > 0 ? { ...result, providerErrors: errors } : result
  } catch (error) {
    if (errors.length === 0) throw error
    throw new Error(`${errorMessage(error)}. Providers tried: ${errors.join("; ")}`)
  }
}

async function runEnvStage(
  url: string,
  rawHtml: boolean,
  signal?: AbortSignal,
  sessionKey?: string
): Promise<FetchResult | null> {
  const envStage = process.env.WEB_TOOLS_FETCH_STAGE
  if (!envStage) return null

  if (envStage === "defuddle") return defuddle(url, !rawHtml, signal)

  if (!rawHtml && envStage === "content-negotiation") {
    const result = await fetchMarkdownViaContentNegotiation(url, signal)
    if (result) return result
    throw new Error("Content negotiation failed — server did not return markdown")
  }

  const extractors = rawHtml ? [jina, firecrawl, you] : apiExtractors
  const extractor = extractors.find((e) => e.name === envStage)
  if (extractor) {
    let extracted: Awaited<ReturnType<Extractor["extract"]>>
    try {
      extracted = await extractor.extract(url, signal, { rawHtml, sessionKey })
    } catch (error) {
      throw new Error(`Extractor "${envStage}" failed: ${errorMessage(error)}`)
    }
    if (extracted) return buildResult(url, extracted, extractor.name, rawHtml)
    throw new Error(
      rawHtml
        ? `Extractor "${envStage}" returned no HTML content`
        : `Extractor "${envStage}" returned no content`
    )
  }

  if (rawHtml) {
    throw new Error(
      `Stage "${envStage}" not supported for rawHtml. Supported: jina-ai, firecrawl, you, defuddle`
    )
  }

  throw new Error(`Unknown stage "${envStage}"`)
}

export async function fetchRawHtml(
  url: string,
  signal?: AbortSignal,
  sessionKey?: string
): Promise<FetchResult> {
  const envResult = await runEnvStage(url, true, signal, sessionKey)
  if (envResult) return envResult

  const errors: string[] = []
  const result = await firstExtracted(url, [jina, firecrawl, you], true, errors, signal, sessionKey)
  if (result) return errors.length > 0 ? { ...result, providerErrors: errors } : result

  return finalFallback(url, false, errors, signal)
}

export async function fetchAndExtract(
  url: string,
  signal?: AbortSignal,
  sessionKey?: string
): Promise<FetchResult> {
  const envResult = await runEnvStage(url, false, signal, sessionKey)
  if (envResult) return envResult

  const markdownResult = await fetchMarkdownViaContentNegotiation(url, signal)
  if (markdownResult) return markdownResult

  const errors: string[] = []
  const result = await firstExtracted(url, apiExtractors, false, errors, signal, sessionKey)
  if (result) return errors.length > 0 ? { ...result, providerErrors: errors } : result

  return finalFallback(url, true, errors, signal)
}
