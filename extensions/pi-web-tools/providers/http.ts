export interface FetchWithTimeoutOptions extends RequestInit {
  timeout?: number
}

export async function fetchWithTimeout(
  url: string,
  init: FetchWithTimeoutOptions = {},
  defaultTimeout = 30_000
): Promise<Response> {
  const { timeout = defaultTimeout, signal, ...fetchInit } = init
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timeoutId = setTimeout(abort, timeout)

  try {
    if (signal) {
      if (signal.aborted) abort()
      else signal.addEventListener("abort", abort, { once: true })
    }
    return await fetch(url, { ...fetchInit, signal: controller.signal })
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener("abort", abort)
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

export interface PostJsonOptions {
  url: string
  apiKeyEnv: string
  headers: Record<string, string> | ((apiKey: string) => Record<string, string>)
  body: unknown
  signal?: AbortSignal
  timeout?: number
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(body ? `HTTP ${status}: ${body}` : `HTTP ${status}`)
    this.name = "HttpError"
  }
}

const ERROR_BODY_MAX_CHARS = 300

async function errorBody(res: Response) {
  try {
    const body = (await res.text()).replace(/\s+/g, " ").trim()
    return body.length > ERROR_BODY_MAX_CHARS ? `${body.slice(0, ERROR_BODY_MAX_CHARS)}…` : body
  } catch {
    return ""
  }
}

/**
 * POST JSON and parse the response. Returns null only when the API key is not
 * configured; throws HttpError on non-2xx and rethrows network/abort errors so
 * callers can report why a provider failed.
 */
export async function postJsonOrThrow<T>({
  url,
  apiKeyEnv,
  headers,
  body,
  signal,
  timeout,
}: PostJsonOptions): Promise<T | null> {
  const apiKey = process.env[apiKeyEnv]
  if (!apiKey) return null

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: typeof headers === "function" ? headers(apiKey) : headers,
    body: JSON.stringify(body),
    signal,
    timeout,
  })
  if (!res.ok) throw new HttpError(res.status, await errorBody(res))
  return (await res.json()) as T
}
