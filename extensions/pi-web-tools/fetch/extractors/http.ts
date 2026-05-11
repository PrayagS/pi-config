export interface FetchWithTimeoutOptions extends RequestInit {
  timeout?: number
}

function combineSignals(
  signals: Array<AbortSignal | null | undefined>
): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]
  return AbortSignal.any(active)
}

export async function fetchWithTimeout(
  url: string,
  init: FetchWithTimeoutOptions = {},
  defaultTimeout = 30_000
): Promise<Response> {
  const { timeout = defaultTimeout, signal, ...fetchInit } = init
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const combinedSignal = combineSignals([signal, controller.signal])
    return await fetch(
      url,
      combinedSignal ? { ...fetchInit, signal: combinedSignal } : fetchInit
    )
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function fetchJson<T>(
  url: string,
  init: FetchWithTimeoutOptions = {}
): Promise<T | null> {
  try {
    const res = await fetchWithTimeout(url, init)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}
