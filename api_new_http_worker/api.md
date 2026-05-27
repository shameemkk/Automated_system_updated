# Email & Facebook URL Extraction API

HTTP-only scraper. Uses `fetch` + `htmlparser2` streaming parser. No browser. A separate worker handles JS-rendered pages and consumes the `js_rendered: false` flag this service emits.

- Base URL: `http://<host>:<PORT>` (default `PORT=3000`)
- All routes return JSON (`Content-Type: application/json`)
- No auth
- CORS: enabled for all origins

---

## `POST /extract-emails`

Scrapes a single URL, then optionally crawls up to `MAX_SUBPAGE_CRAWLS` same-origin subpages, extracting emails and Facebook URLs from each page.

### Request

**Headers**

| Header | Required | Value |
|---|---|---|
| `Content-Type` | yes | `application/json` |

**Body schema**

| Field | Type | Required | Notes |
|---|---|---|---|
| `url` | string | yes | Must be a valid URL. Non-HTML resources (pdf, images, docs, archives, media) are rejected. See `EXCLUDED_FILE_EXTENSIONS`. |

**Query parameters:** none.

**Example**

```bash
curl -X POST http://localhost:3000/extract-emails \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.iana.org/"}'
```

### Response (200 — success)

```json
{
  "success": true,
  "emails": ["iana@iana.org", "tz@iana.org"],
  "facebook_urls": ["https://www.facebook.com/iana"],
  "crawled_urls": [
    "https://www.iana.org/",
    "https://www.iana.org/about/"
  ],
  "pages_crawled": 23
}
```

**Field schema**

| Field | Type | Always present | Notes |
|---|---|---|---|
| `success` | boolean | yes | `true` for any 200 response (including partial timeouts). |
| `emails` | string[] | yes | Deduplicated, lowercased, filtered. May be empty. |
| `facebook_urls` | string[] | yes | Normalized Facebook/fb.com URLs, tracking params stripped. May be empty. |
| `crawled_urls` | string[] | yes | URLs actually fetched. Capped at `MAX_STORED_VISITED_URLS` (default 200). |
| `pages_crawled` | number | yes | Total pages visited (may exceed `crawled_urls.length` if truncated). |
| `js_rendered` | boolean | only when `false` | Present only if the page was detected as a SPA shell that needs browser rendering. Absent otherwise. Consumer should route the URL to the browser-rendering worker. |
| `partial` | boolean | only when `true` | Present only on timeout — indicates the response contains partial results. |
| `reason` | string | only with `partial` | `"timeout"` when `OVERALL_TIMEOUT_MS` fired mid-scrape. |

### Response (200 — partial / timeout)

Returned when `OVERALL_TIMEOUT_MS` fires before the scrape completes. The accumulator is flushed with whatever it already contains.

```json
{
  "success": true,
  "emails": ["partial@result.com"],
  "facebook_urls": [],
  "crawled_urls": ["https://slow-site.example/"],
  "pages_crawled": 1,
  "partial": true,
  "reason": "timeout"
}
```

Note: `partial: true` with `emails: []` means the URL was reachable but the scrape was too slow to produce results. Distinguishable from a genuinely empty page (which returns without `partial`).

### Response (200 — SPA needing browser rendering)

When early SPA detection fires, the scrape exits fast, skips subpage crawl, and emits the flag:

```json
{
  "success": true,
  "emails": [],
  "facebook_urls": [],
  "crawled_urls": ["https://spa-app.example/"],
  "pages_crawled": 1,
  "js_rendered": false
}
```

### Error responses

| Status | Body shape | Trigger |
|---|---|---|
| 400 | `{ "error": "URL is required", "message": "..." }` | Missing `url` in body. |
| 400 | `{ "error": "Invalid URL format", "message": "..." }` | `new URL(url)` threw. |
| 400 | `{ "error": "Unsupported URL type", "message": "..." }` | URL points at a non-HTML resource (pdf, image, doc, media, archive). |
| 500 | `{ "success": false, "error": "Internal server error", "message": "..." }` | Uncaught exception during scrape. |

### No response (client disconnect)

If the client closes the connection before the scrape finishes, the server aborts all in-flight work and **does not send any response**.

### Behavior details

- **Primary fetch first, then subpages.** Depth-1 subpages come from anchor hrefs + common paths.
- **Early email exit.** Scrape stops fanning out after >=10 unique emails (`EARLY_EXIT_EMAIL_THRESHOLD`).
- **SPA short-circuit.** If the primary page is detected as a SPA shell, subpage crawl is skipped entirely.
- **Per-URL timeout.** Each page has its own `HTTP_TIMEOUT_MS` (default 30s) independent of the overall timeout.
- **Size cap.** Any page exceeding `MAX_HTML_BYTES` (default 5 MB) is cancelled mid-stream.
- **Subpage errors are logged and skipped.**

---

## `GET /health`

Liveness probe. No body, no query.

### Response (200)

```json
{ "status": "OK", "message": "Email extraction API is running (HTTP mode)" }
```

---

## Environment variables (server-side)

All optional. Defaults shown.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `NUM_WORKERS` | `os.cpus().length` (capped by `10`) | Cluster worker count. |
| `MAX_DEPTH` | `2` | Max crawl depth. |
| `SUBPAGE_CONCURRENCY` | `10` | Parallel subpage fetches per request. |
| `MAX_LINKS_PER_PAGE` | `50` | Cap on same-domain candidate links collected per page. |
| `HTTP_TIMEOUT_MS` | `30000` | Per-URL fetch timeout. Min enforced: `5000`. |
| `MAX_STORED_VISITED_URLS` | `200` | Cap on `crawled_urls` array in response. |
| `MAX_SUBPAGE_CRAWLS` | `20` | Cap on subpages fetched per request. |
| `OVERALL_TIMEOUT_MS` | `120000` | Hard ceiling per request. On expiry, returns 200 with `partial: true, reason: "timeout"`. Min enforced: `10000`. |
| `HTTP_MAX_CONCURRENCY` | `10` | Global semaphore limiting in-flight website scrapes per worker. |
| `MAX_HTML_BYTES` | `5242880` (5 MB) | Per-page HTML byte ceiling. Min enforced: `65536`. |
| `MAX_SCRIPT_BYTES` | `262144` (256 KB) | Per-`<script>` buffer cap. Min enforced: `8192`. |

---

## Timeout & abort model

Two distinct signals.

| Signal | Trigger | Effect |
|---|---|---|
| `ac.abort('timeout')` | `OVERALL_TIMEOUT_MS` elapsed | All in-flight work aborts. Response sent as `200 { ..., partial: true, reason: "timeout" }` with partial accumulator. |
| `ac.abort('client-disconnect')` | `res.on('close')` fires with `!res.writableFinished` | All in-flight work aborts. **No response sent**. |

Per-URL `HTTP_TIMEOUT_MS` is a separate, narrower abort inside each `scrapeUrl` call.

---

## SPA detection heuristic

Evaluated every 64 KB of parsed HTML. Triggers if **either** is true:

- `bodyTextLength < 200` AND `scriptCount > 3` AND a framework root element exists (`id="root"`, `id="app"`, `id="__next"`, `id="__nuxt"`)
- `bodyTextLength < 50` AND `scriptCount > 1` AND total bytes seen > 2 KB

When triggered:
- Fetch stream is cancelled.
- `needsBrowserRendering: true` is returned up the stack.
- Response contains `js_rendered: false`.
- Subpage crawl is skipped for that URL.
