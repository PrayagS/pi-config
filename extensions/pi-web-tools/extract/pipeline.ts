import { extractExa } from "./providers/exa"
import { extractFirecrawlSummary } from "./providers/firecrawl"
import { extractParallelTargeted } from "./providers/parallel"
import { extractTavilyTargeted } from "./providers/tavily"
import type { WebExtractItem, WebExtractOutput, WebExtractProviderParams } from "./providers/types"

const providersByName = {
  firecrawl: extractFirecrawlSummary,
  exa: extractExa,
  parallel: extractParallelTargeted,
  tavily: extractTavilyTargeted,
}

const summaryProviders = [extractFirecrawlSummary, extractExa]
const targetedProviders = [extractExa, extractParallelTargeted, extractTavilyTargeted]
const supportedStages = {
  summary: ["firecrawl", "exa"],
  targeted: ["exa", "parallel", "tavily"],
}

function pendingMask(results: WebExtractItem[]): boolean[] {
  return results.map((item) => !item.source)
}

function markMissing(results: WebExtractItem[]) {
  for (const item of results) {
    if (!item.source) item.error = "No provider returned content for this URL"
  }
}

async function runEnvStage(
  params: Omit<WebExtractProviderParams, "pending" | "signal">,
  signal?: AbortSignal
): Promise<WebExtractOutput | null> {
  const envStage = process.env.PI_WEB_EXTRACT_STAGE
  if (!envStage) return null

  if (!supportedStages[params.mode].includes(envStage)) {
    throw new Error(
      `Stage "${envStage}" not supported for ${params.mode}. Supported: ${supportedStages[params.mode].join(", ")}`
    )
  }

  const provider = providersByName[envStage as keyof typeof providersByName]
  const providerResults = await provider({
    ...params,
    pending: params.urls.map(() => true),
    signal,
  })
  if (!providerResults) throw new Error(`Extractor "${envStage}" returned no content`)

  const results: WebExtractItem[] = params.urls.map(
    (url, index) => providerResults[index] ?? { url }
  )
  markMissing(results)

  return {
    mode: params.mode,
    prompt: params.prompt,
    results,
  }
}

export async function runWebExtract(
  params: Omit<WebExtractProviderParams, "pending" | "signal">,
  signal?: AbortSignal
): Promise<WebExtractOutput> {
  const envResult = await runEnvStage(params, signal)
  if (envResult) return envResult

  const results: WebExtractItem[] = params.urls.map((url) => ({ url }))
  const providers = params.mode === "summary" ? summaryProviders : targetedProviders

  for (const provider of providers) {
    const pending = pendingMask(results)
    if (!pending.some(Boolean)) break

    const providerResults = await provider({ ...params, pending, signal })
    if (!providerResults) continue

    for (const [index, item] of providerResults.entries()) {
      if (item && !results[index].source) results[index] = item
    }
  }

  markMissing(results)

  return {
    mode: params.mode,
    prompt: params.prompt,
    results,
  }
}
