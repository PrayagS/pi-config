# fetch-url

Pi tool extension that adds `fetch_url`.

`fetch_url` fetches a page and returns clean Markdown. It prefers markdown responses when available, otherwise extracts readable HTML content with Defuddle.

## Features

- **Domain handlers** — GitHub, Hacker News, and Reddit get specialized extraction (structured APIs or CLI instructions) instead of generic HTML scraping
- **Jina AI Reader** — falls back to Jina AI's Reader API (`https://r.jina.ai/`) before markdown.new; requires `PI_WEB_FETCH_JINA_API_KEY` environment variable
- **markdown.new proxy** — falls back to `https://markdown.new/` before Defuddle
- automatic truncation to Pi limits
- saves full output to temp file when truncated so agent can page it with `read`

## Parameters

- `url`
