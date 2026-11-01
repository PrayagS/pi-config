export interface WebSearchResult {
  title: string
  url: string
  snippet?: string
  published?: string | null
  source?: string
}

export interface KagiResult extends WebSearchResult {
  t: 0
  rank: number
}

export interface KagiRelated {
  t: 1
  list: string[]
}

export interface KagiResponse {
  data: Array<KagiResult | KagiRelated>
}

export type SearchAge = "day" | "week" | "month" | "year"

export interface SearchFilters {
  age?: SearchAge
  includeDomains?: string[]
  excludeDomains?: string[]
  includeContent?: boolean
}

export interface WebSearchDetails {
  queries: string[]
  limit: number
  resultCount: number
  urls?: string[]
  sources?: Record<string, number>
  /** Provider request warnings; kept out of model-visible content. */
  warnings?: string[]
  error?: string
}
