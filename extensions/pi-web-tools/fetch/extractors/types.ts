export interface ExtractResult {
  markdown: string
  title?: string
  byline?: string
  metadata?: Record<string, unknown>
}

export interface Extractor {
  name: string
  extract(url: string, signal?: AbortSignal): Promise<ExtractResult | null>
}
