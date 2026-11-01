export interface ExtractResult {
  markdown: string
  /** Raw HTML content when extractor is in rawHtml mode */
  html?: string
  title?: string
  byline?: string
  metadata?: Record<string, unknown>
}

export interface ExtractorOptions {
  rawHtml?: boolean
  /** Stable id of the calling pi session, for providers with task sessions. */
  sessionKey?: string
}

export interface Extractor {
  name: string
  /**
   * Returns null when the extractor is not configured (e.g. no API key).
   * Throws with a reason when the provider fails or returns no content.
   */
  extract(url: string, signal?: AbortSignal, options?: ExtractorOptions): Promise<ExtractResult | null>
}
