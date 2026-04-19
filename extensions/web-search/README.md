# web-search

Pi tool extension that adds `web_search` backed by `kagi` CLI.

Runs one or more web queries in parallel and returns numbered result blocks with title, URL, published date, and snippet.

## Parameters

- `queries[]`
- `limit?`
- `verbatim?`
- `region?`
- `time?`
- `fromDate?`
- `toDate?`
- `order?`

## Notes

- uses `kagi search --format compact`
- aggregates per-query failures into result text
- includes result URLs in tool details for compact rendering
