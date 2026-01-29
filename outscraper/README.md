# Email Outscraper Worker

This worker processes email scraping jobs using the Outscraper API for websites that need more advanced email extraction.

## Features

- Processes `email_scraper_node` records with `status='queued'` and `scrape_type='outscraper'`
- Two-step API process:
  1. Initiates email scraping request to Outscraper
  2. Polls for completion and extracts results
- Automatic retry mechanism for failed jobs (up to 3 attempts)
- Concurrent processing with configurable limits
- Graceful shutdown handling

## API Flow

1. **Initiate Request**: `GET https://api.app.outscraper.com/emails-and-contacts?query={{website}}`
   - Returns: `{"id": "request-id", "status": "Pending", "results_location": "..."}`

2. **Single Status Check**: `GET https://api.outscraper.cloud/requests/{{id}}`
   - Checks once after 5 seconds
   - If "Success": Extract emails and complete job
   - If "Pending" or other: Leave as `outscraper_pending` for later processing

3. **Stale Pending Processing**: Separate process checks `outscraper_pending` jobs after 2+ minutes

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_supabase_service_key
OUTSCRAPER_API_KEY=your_outscraper_api_key
MAX_CONCURRENCY=5
API_CALL_DELAY=2000
DEBUG=false
```

## Installation

```bash
npm install
```

## Usage

```bash
# Development mode with auto-reload
npm run dev

# Production mode
npm start
```

## Processing Priority

The worker processes jobs in this priority order:

1. **New Queued Jobs**: `status='auto_need_outscraper'` AND `scrape_type='outscraper'`
2. **Stale Pending Jobs**: `status='outscraper_pending'` AND `updated_at > 2 minutes ago`
3. **Error Jobs**: `status='outscraper_error'` AND `retry_count < 3` (only when queue is empty)

## Status Flow

1. `auto_need_outscraper` → `processing` → `outscraper_pending` → `auto_completed`/`outscraper_error`
2. Pending jobs are checked after 2+ minutes for completion
3. Error jobs are automatically retried up to 3 times
4. Jobs stuck in `outscraper_pending` status are automatically rechecked

## Database Access

The worker directly queries the `email_scraper_node` table:

- **Fetch Jobs**: `SELECT * FROM email_scraper_node WHERE status='auto_need_outscraper' AND scrape_type='outscraper'`
- **Claim Jobs**: `UPDATE email_scraper_node SET status='processing' WHERE id IN (...)`
- **Complete Jobs**: `UPDATE email_scraper_node SET status='auto_completed', emails=[...] WHERE id=?`
- **Error Jobs**: `UPDATE email_scraper_node SET status='outscraper_error', message=? WHERE id=?`
- **Stale Pending**: Uses RPC function `get_stale_pending_jobs(batch_size)` to find jobs outscraper_pending > 2 minutes

## Status Flow

1. `auto_need_outscraper` + `scrape_type='outscraper'` → Worker picks up job
2. `processing` → Worker initiates Outscraper request
3. `outscraper_pending` → Waiting for Outscraper to complete
4. `auto_completed` → Emails extracted and stored
5. `outscraper_error` → Job failed (will retry up to 3 times)

## Monitoring

The worker logs:
- Job processing progress
- API response details (when DEBUG=true)
- Error messages and retry attempts
- Performance statistics