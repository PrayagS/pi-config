import { extractExa } from "./providers/exa"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { extractFirecrawl } from "./providers/firecrawl"
import { createKagiSummaryExtractor } from "./providers/kagi"
import { extractParallelTargeted } from "./providers/parallel"
import { extractTavilyTargeted } from "./providers/tavily"
import type { WebExtractItem, WebExtractOutput, WebExtractProviderParams } from "./providers/types"

type WebExtractProvider = (
  params: WebExtractProviderParams
) => Promise<Array<WebExtractItem | null> | null>

function pendingMask(results: WebExtractItem[]): boolean[] {
  return results.map((item) => !item.source)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one provider and merge its output. Items with a `source` fill pending URLs;
 * items with only an `error`, and thrown errors, are recorded per URL as
 * "provider: reason".
 */
async function runProvider(
  name: string,
  provider: WebExtractProvider,
  params: Omit<WebExtractProviderParams, "pending" | "signal">,
  results: WebExtractItem[],
  errors: string[][],
  signal?: AbortSignal
) {
  const pending = pendingMask(results)
  let providerResults: Array<WebExtractItem | null> | null
  try {
    providerResults = await provider({ ...params, pending, signal })
  } catch (error) {
    if (signal?.aborted) throw error
    for (const [index, isPending] of pending.entries()) {
      if (isPending) errors[index].push(`${name}: ${errorMessage(error)}`)
    }
    return
  }
  if (!providerResults) return

  for (const [index, item] of providerResults.entries()) {
    if (!item || results[index].source) continue
    if (item.source) results[index] = item
    else if (item.error) errors[index].push(`${name}: ${item.error}`)
  }
}

function markMissing(results: WebExtractItem[], errors: string[][]) {
  for (const [index, item] of results.entries()) {
    if (item.source) continue
    const reasons = errors[index]
    item.error =
      reasons.length > 0
        ? `No provider returned content for this URL (${reasons.join("; ")})`
        : "No provider returned content for this URL"
  }
}

export async function runWebExtract(
  pi: ExtensionAPI,
  params: Omit<WebExtractProviderParams, "pending" | "signal">,
  signal?: AbortSignal
): Promise<WebExtractOutput> {
  const extractKagiSummary = createKagiSummaryExtractor(pi)
  const providersByName: Record<string, WebExtractProvider> = {
    firecrawl: extractFirecrawl,
    exa: extractExa,
    parallel: extractParallelTargeted,
    tavily: extractTavilyTargeted,
    kagi: extractKagiSummary,
  }
  const supportedStages = {
    summary: ["firecrawl", "exa", "kagi"],
    // Firecrawl highlights last: it bills 5 credits per page.
    targeted: ["exa", "parallel", "tavily", "firecrawl"],
  }

  const envStage = process.env.WEB_TOOLS_EXTRACT_STAGE
  if (envStage && !supportedStages[params.mode].includes(envStage)) {
    throw new Error(
      `Stage "${envStage}" not supported for ${params.mode}. Supported: ${supportedStages[params.mode].join(", ")}`
    )
  }
  const order = envStage ? [envStage] : supportedStages[params.mode]

  const results: WebExtractItem[] = params.urls.map((url) => ({ url }))
  const errors: string[][] = params.urls.map(() => [])

  for (const name of order) {
    if (signal?.aborted) throw new Error("cancelled")
    if (!pendingMask(results).some(Boolean)) break
    await runProvider(name, providersByName[name], params, results, errors, signal)
  }

  if (envStage && !results.some((item) => item.source)) {
    const reasons = errors.flat()
    throw new Error(
      reasons.length > 0
        ? `Extractor "${envStage}" returned no content: ${reasons.join("; ")}`
        : `Extractor "${envStage}" returned no content`
    )
  }

  markMissing(results, errors)

  return {
    mode: params.mode,
    prompt: params.prompt,
    results,
  }
}
