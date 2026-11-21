import type { WebExtractItem } from "./types"

export interface SelectedUrl {
  url: string
  index: number
}

export function selectPending(urls: string[], pending?: boolean[]): SelectedUrl[] {
  return urls
    .map((url, index) => ({ url, index }))
    .filter(({ index }) => !pending || pending[index])
}

export function emptyScatter<T>(urls: string[]): Array<T | null> {
  return urls.map(() => null)
}

export function hasAny<T>(items: Array<T | null>): boolean {
  return items.some(Boolean)
}

/**
 * Record provider-reported per-URL failures as error items (no `source`), so the
 * pipeline can report why a URL failed. URLs that already have content are kept.
 */
function scatterErrors<T extends { url: string; error?: string }>(
  output: Array<T | { url: string; error: string } | null>,
  selected: SelectedUrl[],
  failures: Array<{ url: unknown; message: string }>
) {
  const byUrl = new Map<string, string>()
  for (const { url, message } of failures) {
    if (typeof url === "string") byUrl.set(normalizeUrl(url), message)
  }
  for (const { url, index } of selected) {
    if (output[index]) continue
    const message = byUrl.get(normalizeUrl(url))
    if (message) output[index] = { url, error: message }
  }
}

/** Comparable form of a URL: no fragment, no trailing slash. */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url.trim())
    parsed.hash = ""
    return parsed.toString().replace(/\/+$/, "")
  } catch {
    return url.trim().replace(/\/+$/, "")
  }
}

function urlSet(urls: unknown[]): Set<string> {
  return new Set(
    urls.filter((url): url is string => typeof url === "string").map(normalizeUrl)
  )
}

/**
 * Pair batch results with the requested URLs by URL. Batch APIs omit failed URLs
 * from results and may reorder them, so positional matching attaches content to
 * the wrong URL. A single leftover result is paired with a single leftover
 * non-failed URL (e.g. after a redirect); otherwise unmatched results are dropped.
 */
function matchResults<R>(
  selected: SelectedUrl[],
  results: unknown,
  resultUrls: (result: R) => unknown[],
  failed: Set<string> = new Set()
): Map<number, R> {
  const list = (Array.isArray(results) ? results : []) as R[]
  const byUrl = new Map<string, R>()
  for (const result of list) {
    for (const url of urlSet(resultUrls(result))) {
      if (!byUrl.has(url)) byUrl.set(url, result)
    }
  }

  const matched = new Map<number, R>()
  const used = new Set<R>()
  const leftoverUrls: SelectedUrl[] = []
  for (const item of selected) {
    const key = normalizeUrl(item.url)
    if (failed.has(key)) continue
    const result = byUrl.get(key)
    if (result && !used.has(result)) {
      matched.set(item.index, result)
      used.add(result)
    } else {
      leftoverUrls.push(item)
    }
  }

  const leftoverResults = list.filter((result) => !used.has(result))
  if (leftoverUrls.length === 1 && leftoverResults.length === 1) {
    matched.set(leftoverUrls[0].index, leftoverResults[0])
  }
  return matched
}

/**
 * Scatter one batch response back onto the requested URLs. Results are paired
 * with URLs by `matchResults`, `toItem` turns each match into an item (or null
 * when it has no usable content), and `failures` become error items for URLs
 * left empty. Returns null when no URL got an item or an error.
 */
export function scatterBatch<R>(
  urls: string[],
  selected: SelectedUrl[],
  batch: {
    results: unknown
    resultUrls: (result: R) => unknown[]
    failures: Array<{ url: unknown; message: string }>
  },
  toItem: (url: string, result: R) => WebExtractItem | null
): Array<WebExtractItem | null> | null {
  const output = emptyScatter<WebExtractItem>(urls)
  const failed = urlSet(batch.failures.map(({ url }) => url))
  const matched = matchResults<R>(selected, batch.results, batch.resultUrls, failed)
  for (const { url, index } of selected) {
    const result = matched.get(index)
    if (result !== undefined) output[index] = toItem(url, result)
  }
  scatterErrors(output, selected, batch.failures)
  return hasAny(output) ? output : null
}
