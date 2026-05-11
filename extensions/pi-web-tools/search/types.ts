export interface KagiResult {
  t: 0
  rank: number
  title: string
  url: string
  snippet?: string
  published?: string | null
}

export interface KagiRelated {
  t: 1
  list: string[]
}

export interface KagiResponse {
  data: Array<KagiResult | KagiRelated>
}

export interface SearchFilters {
  verbatim?: boolean
  region?: string
  time?: string
  fromDate?: string
  toDate?: string
  order?: string
}

export interface WebSearchDetails {
  queries: string[]
  limit: number
  resultCount: number
  urls?: string[]
  error?: string
}
