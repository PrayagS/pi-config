// Throws on HTTP/network errors; returns null only when the API key is unset.
import { postJsonOrThrow as postJson } from "./http"

/**
 * Parallel session ids keyed by pi session id. Parallel groups search and
 * extract calls that belong to "the same larger task" by session_id, so search
 * and extract share one session per pi session. Calls without a pi session id
 * send no session_id.
 */
const sessionIds = new Map<string, string>()

export function parallelSessionId(sessionKey?: string): string | undefined {
  return sessionKey ? sessionIds.get(sessionKey) : undefined
}

export function rememberParallelSession(sessionKey: string | undefined, sessionId: unknown) {
  if (sessionKey && typeof sessionId === "string") sessionIds.set(sessionKey, sessionId)
}

export interface ParallelExtractParams {
  urls: string[]
  objective?: string
  advanced_settings?: Record<string, unknown>
  max_chars_total?: number
}

/** Readable reason for an entry in /v1/extract `errors`. */
export function parallelError(error: any): string {
  const type = typeof error?.error_type === "string" ? error.error_type : "error"
  const code = error?.http_status_code
  return code ? `${type} (HTTP ${code})` : type
}

export async function extractParallel(
  params: ParallelExtractParams,
  signal?: AbortSignal,
  sessionKey?: string
): Promise<any | null> {
  const body: Record<string, unknown> = { ...params }
  const sessionId = parallelSessionId(sessionKey)
  if (sessionId) body.session_id = sessionId

  const json = await postJson<any>({
    url: "https://api.parallel.ai/v1/extract",
    apiKeyEnv: "WEB_TOOLS_PARALLEL_API_KEY",
    headers: (apiKey) => ({
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    }),
    body,
    signal,
  })
  rememberParallelSession(sessionKey, json?.session_id)
  return json
}
