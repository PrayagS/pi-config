// Throws on HTTP/network errors; returns null only when the API key is unset.
import { postJsonOrThrow as postJson } from "./http"

let sessionId: string | undefined

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
  signal?: AbortSignal
): Promise<any | null> {
  const body: Record<string, unknown> = { ...params }
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
  if (json?.session_id) sessionId = json.session_id
  return json
}
