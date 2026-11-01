export type WebExtractMode = "summary" | "targeted"
export type WebExtractSource = "firecrawl" | "exa" | "parallel" | "tavily" | "kagi"

export interface WebExtractProviderParams {
  urls: string[]
  mode: WebExtractMode
  prompt?: string
  pending?: boolean[]
  signal?: AbortSignal
  /** Stable id of the calling pi session, for providers with task sessions. */
  sessionKey?: string
}

export interface WebExtractItem {
  url: string
  title?: string
  content?: string
  excerpts?: string[]
  error?: string
  source?: WebExtractSource
  metadata?: Record<string, unknown>
}

export interface WebExtractOutput {
  mode: WebExtractMode
  prompt?: string
  results: WebExtractItem[]
  metadata?: Record<string, unknown>
}
