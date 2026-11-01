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

/** Comparable form of a URL: no fragment, no trailing slash. */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url.trim())
    parsed.hash = ""
    return parsed.toString().replace(/\/+$/, "")
  } catch {
    return url.trim().replace(/\/+$/, "")
  }
}

export function urlSet(urls: unknown[]): Set<string> {
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
export function matchResults<R>(
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
