# pi-web-tools

Pi extension providing `web_search`, `web_fetch`, and `web_extract` tools.

## Structure

```
├── index.ts                  # extension entry — registers tools
├── providers/                # shared provider API clients
│   ├── http.ts               #   fetchWithTimeout + fetchJson + postJson
│   ├── kagi.ts               #   Kagi CLI argument builder
│   ├── firecrawl.ts          #   Firecrawl scrape client
│   ├── exa.ts                #   Exa contents client
│   ├── parallel.ts           #   Parallel extract client + session reuse
│   ├── tavily.ts             #   Tavily extract client
│   ├── jina.ts               #   Jina Reader client
│   └── you.ts                #   You.com contents client
├── search/                   # web_search tool
│   ├── index.ts              #   createWebSearchTool factory + execute
│   ├── kagi.ts               #   Kagi result formatting
│   ├── render.ts             #   render functions
│   └── types.ts              #   Kagi response/tool detail types
├── fetch/                    # web_fetch tool
│   ├── index.ts              #   webFetchTool config (domain dispatch → pipeline → truncate)
│   ├── pipeline.ts           #   fetchAndExtract/fetchRawHtml orchestration
│   ├── content-negotiation.ts #   direct markdown fetch stage
│   ├── defuddle.ts           #   Defuddle fallback extraction
│   ├── result.ts             #   FetchResult types + result builder
│   ├── render.ts             #   render functions
│   ├── truncate.ts           #   truncation helper
│   ├── extractors/           #   API content extractor adapters
│   │   ├── index.ts          #     barrel + apiExtractors registry
│   │   ├── types.ts          #     Extractor interface
│   │   ├── jina.ts → firecrawl.ts → parallel.ts → exa.ts → tavily.ts → you.ts
│   │   └── markdown-new.ts
│   ├── domain-handlers/      #   specialized handlers for GitHub, HN, Reddit
│   └── test-handlers.ts      #   domain handler smoke tests
├── extract/                  # web_extract tool
│   ├── index.ts              #   webExtractTool config + validation
│   ├── pipeline.ts           #   summary/targeted provider fallback orchestration
│   ├── render.ts             #   TUI render functions
│   ├── render-markdown.ts    #   markdown output formatting
│   └── providers/            #   web_extract provider adapters
├── package.json
└── README.md
```

## Adding an extractor

1. Create `fetch/extractors/<name>.ts` implementing `Extractor`
2. Export named const with `name` + `extract(url)` method
3. Register in `fetch/extractors/index.ts` barrel + `apiExtractors` array
4. Add stage name to `ExtractionStage` union in `fetch/result.ts`

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
   - Exa.ai (`PI_WEB_FETCH_EXA_API_KEY`)
   - Tavily (`PI_WEB_FETCH_TAVILY_API_KEY`)
   - You.com (`PI_WEB_FETCH_YOU_API_KEY`)
   - markdown.new proxy
4. **Defuddle** — default HTML extraction

Large outputs are truncated to Pi limits and saved to a temp file for paging.

Set `PI_WEB_FETCH_STAGE` to force one fetch stage:

- `content-negotiation`
- `jina-ai`
- `firecrawl`
- `parallel`
- `tavily`
- `exa`
- `you`
- `markdown-new`
- `defuddle`

### Parameters

- `url` — URL to fetch

## `web_extract`

Extract summaries or targeted information from up to 5 URLs.

### Parameters

- `urls[]` — 1 to 5 URLs to extract from
- `mode` — `summary` or `targeted`
- `prompt?` — required for `targeted`, ignored for `summary`

### Provider order

- `summary`: Firecrawl → Exa
- `targeted`: Exa → Parallel → Tavily

Set `PI_WEB_EXTRACT_STAGE` to force one provider:

- `summary`: `firecrawl`, `exa`
- `targeted`: `exa`, `parallel`, `tavily`

Firecrawl is single-URL only, so summary mode fans out one scrape request per URL before falling back to Exa for missing URLs.

### Response mapping

- Firecrawl summary → `data.summary`
- Exa summary/targeted → `results[].summary`
- Parallel targeted → `results[].excerpts[]`
- Tavily targeted → `results[].raw_content`

Provider credentials reuse existing environment variables:

- `PI_WEB_FETCH_FIRECRAWL_API_KEY`
- `PI_WEB_FETCH_EXA_API_KEY`
- `PI_WEB_FETCH_PARALLEL_API_KEY`
- `PI_WEB_FETCH_TAVILY_API_KEY`

