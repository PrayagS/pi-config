# fetch-url

Pi tool extension that adds `fetch_url`.

`fetch_url` fetches a page and returns clean Markdown. It prefers markdown responses when available, otherwise extracts readable HTML content with Defuddle.

## Features

- **Domain handlers** — GitHub, Hacker News, and Reddit get specialized extraction (structured APIs or CLI instructions) instead of generic HTML scraping
- **Jina AI Reader** — falls back to Jina AI's Reader API (`https://r.jina.ai/`) before Firecrawl; requires `PI_WEB_FETCH_JINA_API_KEY` environment variable
- **Firecrawl** — falls back to Firecrawl scrape API (`https://api.firecrawl.dev/v2/scrape`) before Parallel; requires `PI_WEB_FETCH_FIRECRAWL_API_KEY` environment variable
- **Parallel** — falls back to Parallel Extract API (`https://api.parallel.ai/v1/extract`) before Tavily; requires `PI_WEB_FETCH_PARALLEL_API_KEY` environment variable
- **Tavily** — falls back to Tavily extract API (`https://api.tavily.com/extract`) before Exa.ai; requires `PI_WEB_FETCH_TAVILY_API_KEY` environment variable
- **Exa.ai** — falls back to Exa.ai contents API (`https://api.exa.ai/contents`) before You.com; requires `PI_WEB_FETCH_EXA_API_KEY` environment variable
- **You.com** — falls back to You.com Contents API (`https://ydc-index.io/v1/contents`) before markdown.new; requires `PI_WEB_FETCH_YOU_API_KEY` environment variable
- **markdown.new proxy** — falls back to `https://markdown.new/` before Defuddle
- automatic truncation to Pi limits
- saves full output to temp file when truncated so agent can page it with `read`

## Parameters

- `url`
