# HTTP Request Worker

## Recent changes

- **Batch DB updates**: Results are buffered in memory and written to Supabase in batches via RPC `auto_batch_update_email_scraper_nodes` instead of one update per job. Reduces connection/rate-limit errors.
- **Flush policy**: Batch is flushed every `BATCH_FLUSH_INTERVAL_MS` (default 10s) or when buffer size reaches `BATCH_FLUSH_SIZE` (default 25). Remaining buffer is flushed on graceful shutdown.
- **RPC failure handling**: If a batch RPC fails, updates are re-queued for up to 3 flush attempts; after that they are dropped and their IDs are logged.

## Overview
The HTTP Request Worker is the first stage in the email scraping pipeline. It performs fast HTTP-based scraping of websites to extract emails and Facebook URLs without using a browser.

## How It Works

### 1. Job Processing Flow
```
auto_queued → auto_processing → auto_completed/auto_need_google_search/auto_need_browser_rendering/auto_error
```

### 2. Status Transitions

- **auto_queued**: Initial status for new scraping jobs
- **auto_processing**: Job is currently being scraped
- **auto_completed**: Successfully found emails
- **auto_need_google_search**: No emails found, needs Google Search fallback
- **auto_need_browser_rendering**: Site requires JavaScript rendering
- **auto_error**: Scraping failed (with retry logic)

### 3. Core Components

#### Scraper (`scraper.ts`)
- Performs HTTP requests to fetch website HTML
- Extracts emails using regex patterns
- Extracts Facebook URLs from links and text
- Detects if site needs browser rendering (JavaScript-heavy sites)

#### Worker (`worker.ts`)
- Manages concurrent job processing using `p-queue`
- Claims jobs atomically using RPC function `get_next_email_scraper_nodes_http_request`
- Determines next status based on scraping results
- Updates database with results

#### Normalizer (`worker-utils.ts`)
- Normalizes scraper responses into consistent format
- Handles success/error cases
- Detects browser rendering requirements

### 4. Decision Logic

After scraping, the worker determines the next status:

```typescript
if (hasEmails) {
    status = 'auto_completed'
} else if (hasFacebookUrls && !hasEmails) {
    status = 'auto_need_google_search'
} else if (needs_browser_rendering) {
    status = 'auto_need_browser_rendering'
} else if (completed && !hasEmails) {
    status = 'auto_need_google_search'
}
```

### 5. Error Handling

- Errors are marked as `auto_error`
- Failed jobs can be retried using RPC function `retry_error_jobs_http_request`
- Retry logic checks for jobs with `retry_count <= 2`

## Configuration

Environment variables in `.env`:

```env
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_service_key
MAX_CONCURRENCY=50  # Number of concurrent scraping jobs
```

## Database Schema

Required table: `email_scraper_node`

Key columns:
- `id`: Primary key
- `url`: Website URL to scrape
- `status`: Current job status
- `scrape_type`: Set to 'http_request'
- `emails`: Array of extracted emails
- `facebook_urls`: Array of Facebook URLs
- `needs_browser_rendering`: Boolean flag
- `message`: Error message if failed
- `retry_count`: Number of retry attempts

## Running the Worker

```bash
npm install
npm start
```

## Performance

- Fast HTTP-only scraping (no browser overhead)
- Handles 50+ concurrent requests by default
- Typical processing time: 1-5 seconds per URL
- Automatically routes complex sites to browser rendering

## Next Steps

Jobs are routed to:
- **Google Search Worker**: When no emails found
- **Browser Rendering Worker**: When JavaScript rendering needed
- **Completed**: When emails successfully extracted
