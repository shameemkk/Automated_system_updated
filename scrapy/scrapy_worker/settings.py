# Scrapy settings for scrapy_worker project
# Reference: browser_rendering/index.js

BOT_NAME = "scrapy_worker"
REQUEST_FINGERPRINTER_IMPLEMENTATION = "2.7"
SPIDER_MODULES = ["scrapy_worker.spiders"]
NEWSPIDER_MODULE = "scrapy_worker.spiders"

# Playwright download handlers
DOWNLOAD_HANDLERS = {
    "http": "scrapy_playwright.handler.ScrapyPlaywrightDownloadHandler",
    "https": "scrapy_playwright.handler.ScrapyPlaywrightDownloadHandler",
}
TWISTED_REACTOR = "twisted.internet.asyncioreactor.AsyncioSelectorReactor"

# Block images, media, fonts, stylesheets (mirror reference PLAYWRIGHT_BLOCKED_RESOURCE_TYPES)
PLAYWRIGHT_BLOCKED_RESOURCE_TYPES = {"image", "media", "font", "stylesheet", "other"}


def should_abort_request(request):
    return request.resource_type in PLAYWRIGHT_BLOCKED_RESOURCE_TYPES


PLAYWRIGHT_ABORT_REQUEST = should_abort_request

# Playwright launch options (mirror reference PLAYWRIGHT_LAUNCH_ARGS)
PLAYWRIGHT_LAUNCH_OPTIONS = {
    "headless": True,
    "args": [
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--no-sandbox",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--disable-translate",
        "--mute-audio",
        "--no-first-run",
    ],
}

# Navigation timeout (ms) - PAGE_TIMEOUT
PLAYWRIGHT_DEFAULT_NAVIGATION_TIMEOUT = int(__import__("os").environ.get("PAGE_TIMEOUT_MS", "10000"))

# Context limit
PLAYWRIGHT_MAX_CONTEXTS = int(__import__("os").environ.get("PLAYWRIGHT_MAX_CONTEXTS", "10"))

# Concurrency
CONCURRENT_REQUESTS = 1  # Worker processes one job at a time; batch concurrency in main loop

# Obey robots.txt
ROBOTSTXT_OBEY = False

# Disable cookies
COOKIES_ENABLED = False

# Retries
RETRY_ENABLED = True
RETRY_TIMES = 2
RETRY_HTTP_CODES = [500, 502, 503, 504, 408, 429]

# Logging
LOG_LEVEL = "INFO"
LOG_FORMAT = "%(asctime)s [%(name)s] %(levelname)s: %(message)s"
