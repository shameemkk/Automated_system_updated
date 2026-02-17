# Scrapy + Playwright Email Scraper

Python implementation of the browser-rendering email scraper using **Scrapy** and **Playwright**. Mirrors the logic from `browser_rendering/index.js`.

## Features

- **High concurrency** – multiprocessing (N workers in parallel)
- **Fast crawling** – parallel subpage fetches (8 concurrent), early exit when enough emails found
- **More email sources** – mailto, body text, JSON-LD (schema.org), meta tags, `data-*` attributes, obfuscated patterns
- **JS-rendered crawling** via `scrapy-playwright`
- **Facebook URL extraction**
- **Same-domain link following** with configurable depth (e.g. /contact, /about)
- **Email filtering** – blocks tracking, placeholder, and junk domains
- **Resource blocking** – images, media, fonts, stylesheets (faster, lighter)

## Requirements

- Python ≥ 3.10
- Scrapy ≥ 2.7
- Playwright ≥ 1.40

## Installation

```bash
cd scrapy
pip install -r requirements.txt
playwright install chromium
```

## Environment

Create `.env` in the `scrapy/` directory (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CONCURRENCY` | 4 | Number of parallel worker processes |
| `MAX_DEPTH` | 2 | Crawl depth for same-domain links |
| `MAX_SUBPAGE_CRAWLS` | 20 | Max subpages per site |
| `EARLY_EXIT_EMAIL_COUNT` | 3 | Stop following links once this many emails found |
| `PAGE_TIMEOUT_MS` | 10000 | Page load timeout |
| `PLAYWRIGHT_MAX_CONTEXTS` | 8 | Max concurrent browser contexts per crawl |

## Usage

### Run worker (Supabase job loop)

```bash
cd scrapy
python worker.py
```

The worker:

1. Claims jobs via RPC `auto_get_next_email_scraper_nodes_need_browser_rendering`
2. Runs the email spider for each URL
3. Updates `email_scraper_node` with results (status, emails, facebook_urls)

### Run spider manually (single URL)

```bash
cd scrapy
scrapy crawl email -a url=https://example.com
```

## Project structure

```
scrapy/
├── scrapy.cfg
├── requirements.txt
├── worker.py              # Supabase worker loop
├── README.md
└── scrapy_worker/
    ├── settings.py        # Scrapy + Playwright config
    ├── items.py
    ├── pipelines.py       # Result aggregation
    ├── email_filter.py    # Junk email filtering
    ├── spiders/
    │   └── email_spider.py
    └── ...
```

## Database

Uses `email_scraper_node` and RPC functions from `browser_rendering/schema.sql`:

- `auto_get_next_email_scraper_nodes_need_browser_rendering(batch_size)`
- `auto_batch_update_email_scraper_nodes(updates)` (optional, worker uses direct update)

Ensure the schema is applied to your Supabase project.
