# pi-web-tools

Pi extension providing `web_search` and `web_fetch` tools.

## Structure

```
├── index.ts                  # extension entry — registers both tools
├── search/                   # web_search tool
│   └── index.ts              #   createWebSearchTool factory (+ types, execute, render)
├── fetch/                    # web_fetch tool
│   ├── index.ts              #   webFetchTool config (domain dispatch → pipeline → truncate)
│   ├── pipeline.ts           #   fetchAndExtract orchestrator + FetchResult types
│   ├── render.ts             #   render functions
│   ├── truncate.ts           #   truncation helper
│   ├── extractors/           #   API content extractors — self-contained modules
│   │   ├── index.ts          #     barrel + apiExtractors registry
│   │   ├── types.ts          #     Extractor interface
│   │   ├── http.ts           #     shared fetchWithTimeout
│   │   ├── jina.ts → firecrawl.ts → parallel.ts → tavily.ts → exa.ts → you.ts
│   │   └── markdown-new.ts
│   ├── domain-handlers/      #   specialized handlers for GitHub, HN, Reddit
│   └── test-handlers.ts      #   domain handler smoke tests
├── package.json
└── README.md
```

## Adding an extractor

1. Create `fetch/extractors/<name>.ts` implementing `Extractor`
2. Export named const with `name` + `extract(url)` method
3. Register in `fetch/extractors/index.ts` barrel + `apiExtractors` array
4. Add stage name to `ExtractionStage` union in `fetch/pipeline.ts`

## `web_search`

Search the web using the Kagi CLI. Runs one or more queries in parallel and returns numbered result blocks with title, URL, published date, and snippet.

### Parameters

- `queries[]` — search queries (supports Kagi operators: site:, filetype:, intitle:, etc.)
- `limit?` — max results per query (default 10, max 50)
- `verbatim?` — exact match mode
- `region?` — region code (e.g. `us`, `gb`)
- `time?` — `day`, `week`, `month`, `year`
- `fromDate?` / `toDate?` — date range (YYYY-MM-DD)
- `order?` — `default`, `recency`, `website`, `trackers`

Requires the `kagi` CLI to be installed and authenticated.

## `web_fetch`

Fetch a URL and return clean, readable Markdown content.

### Extraction pipeline

1. **Domain handlers** — GitHub, Hacker News, Reddit get specialized extraction
2. **Content negotiation** — prefers markdown if server supports it
3. **API extractors** (priority order) — each self-checks its env var
   - Jina AI Reader (`PI_WEB_FETCH_JINA_API_KEY`)
   - Firecrawl (`PI_WEB_FETCH_FIRECRAWL_API_KEY`)
   - Parallel (`PI_WEB_FETCH_PARALLEL_API_KEY`)
   - Tavily (`PI_WEB_FETCH_TAVILY_API_KEY`)
   - Exa.ai (`PI_WEB_FETCH_EXA_API_KEY`)
   - You.com (`PI_WEB_FETCH_YOU_API_KEY`)
   - markdown.new proxy
4. **Defuddle** — default HTML extraction

Large outputs are truncated to Pi limits and saved to a temp file for paging.

### Parameters

- `url` — URL to fetch
