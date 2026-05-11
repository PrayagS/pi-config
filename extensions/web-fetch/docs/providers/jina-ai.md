# Jina AI Reader

Single-URL extraction service. One request per URL.

**Endpoint**

```
POST https://r.jina.ai/
```

**Authentication**

| Header | Value |
|--------|-------|
| `Authorization` | `Bearer <PI_WEB_FETCH_JINA_API_KEY>` |
| `Content-Type` | `application/json` |
| `Accept` | `application/json` |

**Request Body**

```json
{
  "url": "https://example.com/article"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` (uri) | Yes | The URL to extract content from |

**Response Body**

```json
{
  "data": {
    "content": "# Page Title\n\nPage content in Markdown..."
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `data.content` | `string` | Extracted markdown content |

**Notes**

- One URL per request. No batching.
- Response is JSON with the markdown content in `data.content`.
- The implementation reads `json?.data?.content` and trims whitespace.
