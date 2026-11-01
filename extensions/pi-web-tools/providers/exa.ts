// Throws on HTTP/network errors; returns null only when the API key is unset.
import { postJsonOrThrow as postJson } from "./http"

export interface ExaContentsParams {
  /** `ids` is the legacy, backwards-compatible name for this field. */
  urls: string[]
  text?: boolean | Record<string, unknown>
  summary?: boolean | Record<string, unknown>
}

/** Readable reason for a non-success entry in /contents `statuses`. */
export function exaStatusError(status: any): string {
  const tag = typeof status?.error?.tag === "string" ? status.error.tag : "error"
  const code = status?.error?.httpStatusCode
  return code ? `${tag} (HTTP ${code})` : tag
}

export async function getExaContents(
  params: ExaContentsParams,
  signal?: AbortSignal
): Promise<any | null> {
  return postJson({
    url: "https://api.exa.ai/contents",
    apiKeyEnv: "WEB_TOOLS_EXA_API_KEY",
    headers: (apiKey) => ({
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    }),
    body: params,
    signal,
  })
}
