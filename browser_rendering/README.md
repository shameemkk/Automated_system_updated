# Browser Rendering Worker

## Overview
The Browser Rendering Worker handles JavaScript-heavy websites that require a real browser to render properly. It uses Playwright with Chromium to scrape websites that failed with simple HTTP requests.

## How It Works

### 1. Job Processing Flow
```
auto_need_browser_rendering → auto_br_processing → auto_completed/auto_need_google_search/auto_error
```

### 2. Status Transitions

- **auto_need_browser_rendering**: Job needs browser rendering (from HTTP Request Worker)
- **auto_br_processing**: Currently being rendered and scraped
- **auto_completed**: Successfully found emails
- **auto_need_google_search**: No emails found, needs Google Search fallback
- **auto_error**: Rendering/scraping failed

### 3. Browser Architecture

#### Shared Browser Instance
- Single Chromium browser shared across all jobs
- Reduces memory overhead and startup time
- Automatically reconnects if disconnected

#### Context Pooling
- Reuses browser contexts up to `PLAYWRIGHT_MAX_CONTEXTS` limit
- Each context has unique user agent for rotation
- Contexts are isolated from each other

#### Resource Blocking
Blocks unnecessary resources for faster loading:
- Images
- Media files
- Fonts
- Stylesheets
- Other non-essential resources

### 4. Scraping Strategy

#### Multi-Depth Crawling

**Depth 0 (Primary Page)**:
- Scrapes the main URL
- Extracts emails and Facebook URLs
- Collects internal links

**Depth 1 (Subpages)**:
- If no emails found on primary page
- Prioritizes common pages: `/contact`, `/about`, `/contact-us`, `/about-us`
- Crawls up to `MAX_SUBPAGE_CRAWLS` additional pages
- Stops early if emails found

#### Email Extraction

Extracts emails from:
- `mailto:` links
- Page text content using regex
- Filters out junk emails (see Email Filtering section)

#### Facebook URL Extraction

Finds Facebook URLs from:
- Links (`<a href>`)
- Text content

### 5. Email Filtering

Comprehensive filtering to remove junk emails:

**Blocked Domains**:
- Error tracking: sentry.io, newrelic.com, rollbar.com
- Platforms: wordpress.com, wix.com, shopify.com
- Social media: facebook.com, instagram.com, linkedin.com
- CDNs: cloudflare.com, amazonaws.com
- Placeholder domains: example.com, domain.com

**Blocked Local Parts**:
- noreply, no-reply, donotreply
- firstname, lastname, yourname
- Generic placeholders

**Blocked Patterns**:
- URL-encoded characters
- Query strings
- File extensions (.css, .js, .png, etc.)
- Multiple @ symbols

### 6. Concurrency Control

#### Semaphore System
- Limits concurrent browser contexts
- Prevents memory exhaustion
- Queues requests when limit reached

#### Queue Management
- Uses `p-queue` for job concurrency
- Configurable `MAX_CONCURRENCY`
- Separate from browser context limit

### 7. Error Handling

#### Recoverable Errors
Marked as `auto_need_google_search`:
- Timeouts
- Connection errors (ECONNREFUSED, ENOTFOUND)
- SSL/Certificate errors
- DNS resolution failures

#### Non-Recoverable Errors
Marked as `auto_error`:
- Invalid URLs
- Unexpected crashes
- Other fatal errors

#### Retry Logic
- Multiple timeout attempts (2 retries with increased timeout)
- Browser reconnection on disconnect
- Context pool cleanup on errors

## Configuration

Environment variables in `.env`:

```env
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_service_key

# Crawling Configuration
MAX_DEPTH=2                      # Maximum crawl depth (1-2 recommended)
MAX_SUBPAGE_CRAWLS=20           # Max subpages to crawl per site
MAX_LINKS_PER_PAGE=50           # Max links to collect per page
MAX_STORED_VISITED_URLS=200     # Max URLs to store in results

# Performance Configuration
MAX_CONCURRENCY=50              # Job concurrency
BATCH_SIZE=10                   # Jobs to claim per batch
PLAYWRIGHT_MAX_CONTEXTS=10      # Max browser contexts
PAGE_TIMEOUT_MS=10000           # Page load timeout (ms)
```

## Database Schema

Uses table: `email_scraper_node`

Key columns:
- `id`: Primary key
- `url`: Website URL to scrape
- `status`: Current job status
- `scrape_type`: Set to 'browser_rendering'
- `emails`: Array of extracted emails
- `facebook_urls`: Array of Facebook URLs
- `needs_browser_rendering`: Set to false after processing
- `message`: Error message if failed

## Running the Worker

```bash
npm install
npm start
```

## Performance

- Slower than HTTP requests (browser overhead)
- Typical processing time: 5-30 seconds per URL
- Memory usage: ~100-500MB per browser context
- Handles JavaScript-heavy sites effectively

## Resource Requirements

### Minimum
- 2GB RAM
- 2 CPU cores

### Recommended
- 4GB+ RAM
- 4+ CPU cores
- SSD storage

### Docker
- Increase shared memory: `--shm-size=2gb`
- Use `--disable-dev-shm-usage` flag (already configured)

## Optimization Tips

1. **Reduce MAX_DEPTH**: Set to 1 for faster processing
2. **Limit Subpage Crawls**: Lower `MAX_SUBPAGE_CRAWLS` for speed
3. **Adjust Context Pool**: Balance between memory and performance
4. **Increase Timeout**: For slow sites, increase `PAGE_TIMEOUT_MS`
5. **Resource Blocking**: Already optimized, blocks images/media/fonts

## Troubleshooting

### High Memory Usage
- Reduce `PLAYWRIGHT_MAX_CONTEXTS`
- Reduce `MAX_CONCURRENCY`
- Ensure contexts are being returned to pool

### Slow Processing
- Increase `MAX_CONCURRENCY`
- Reduce `MAX_DEPTH` to 1
- Reduce `MAX_SUBPAGE_CRAWLS`

### Browser Crashes
- Check available memory
- Reduce concurrent contexts
- Ensure Docker has enough resources

## Next Steps

After processing:
- **auto_completed**: Job finished with emails found
- **auto_need_google_search**: No emails found, route to Google Search Worker
- **auto_error**: Failed jobs (non-recoverable)
