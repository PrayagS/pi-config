# Firecrawl

Scrape API that converts a single URL to structured output.

**Endpoint**

```
POST https://api.firecrawl.dev/v2/scrape
```

**Authentication**

| Header | Value |
|--------|-------|
| `Authorization` | `Bearer <PI_WEB_FETCH_FIRECRAWL_API_KEY>` |
| `Content-Type` | `application/json` |

**Request Body**

```json
{
  "url": "https://example.com/article",
  "formats": ["markdown"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` (uri) | Yes | The URL to scrape |
| `formats` | `string[]` | No | Output formats. Default: `["markdown"]`. Other options: `html`, `rawHtml`, `summary`, `question`, `highlights`. |

**Response Body (success)**

```json
{
  "success": true,
  "data": {
    "markdown": "# Page Title\n\nContent...",
    "metadata": {
      "title": "Page Title",
      "description": "...",
      "language": "en",
      "sourceURL": "https://example.com/article",
      "url": "https://example.com/article",
      "keywords": "...",
      "statusCode": 200,
      "contentType": "text/html",
      "error": null
    },
    "warning": null
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Whether the scrape succeeded |
| `data.markdown` | `string` | Extracted markdown content |
| `data.metadata.title` | `string \| string[]` | Page title |
| `data.metadata.description` | `string \| string[]` | Meta description |
| `data.metadata.language` | `string \| string[] \| null` | Detected language |
| `data.metadata.sourceURL` | `string` (uri) | Original requested URL |
| `data.metadata.url` | `string` (uri) | Final URL after redirects |
| `data.metadata.keywords` | `string \| string[]` | Meta keywords |
| `data.metadata.statusCode` | `integer` | HTTP status code |
| `data.metadata.contentType` | `string` | MIME type of the page |
| `data.metadata.error` | `string \| null` | Error message if any |
| `data.metadata.concurrencyLimited` | `boolean` | Whether throttled by concurrency limits |
| `data.metadata.concurrencyQueueDurationMs` | `number` | Queue wait time if throttled |
| `data.warning` | `string \| null` | LLM extraction warning if applicable |

**Error Responses**

| Status | Meaning |
|--------|---------|
| `402` | Payment required |
| `429` | Rate limit exceeded |
| `500` | Server error (`{ success: false, code: "UNKNOWN_ERROR", error: "..." }`) |

**Notes**

- Single URL per request. No batching in the `/v2/scrape` endpoint.
- The `markdown` format object in `formats` can include a `type` field: `{ "type": "markdown" }`.
- Response fields depend on which `formats` were requested.

## Formats

Each format can be requested as a plain string (e.g. `"markdown"`) or as an object with a `type` field (e.g. `{ "type": "markdown" }`). Some formats require additional object fields.

| Format | Request | Response field | Description |
|--------|---------|----------------|-------------|
| `markdown` | `"markdown"` or `{ "type": "markdown" }` | `data.markdown` | Extracted markdown content |
| `html` | `"html"` or `{ "type": "html" }` | `data.html` | Cleaned HTML (removes `<script>`, `<style>`, `<noscript>`, `<meta>`, `<head>`; converts relative URLs to absolute; resolves `srcset` to largest image) |
| `rawHtml` | `"rawHtml"` or `{ "type": "rawHtml" }` | `data.rawHtml` | Unmodified HTML as received from the page |
| `summary` | `"summary"` or `{ "type": "summary" }` | `data.summary` | LLM-generated summary of the page |
| `question` | `{ "type": "question", "question": "..." }` | `data.answer` | Natural-language answer to the provided question |
| `highlights` | `{ "type": "highlights", "query": "..." }` | `data.highlights` | Relevant source text selected by the query |

### `question` format

Request object (required):

```json
{
  "type": "question",
  "question": "What is the main argument of this article?"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | `"question"` |
| `question` | `string` | Yes | Question to answer about the page. Max: 10,000 characters. |

Response: `data.answer` — natural-language answer to the question.

### `highlights` format

Request object (required):

```json
{
  "type": "highlights",
  "query": "pricing information"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | `"highlights"` |
| `query` | `string` | Yes | Text-selection query to run against the page. Max: 10,000 characters. |

Response: `data.highlights` — relevant source text selected by the query.
