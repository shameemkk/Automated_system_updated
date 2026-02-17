#!/usr/bin/env python3
"""
Supabase worker - fetches jobs, runs Scrapy+Playwright spider, updates DB.
Optimized for high concurrency, batch updates, and speed.
"""
import os
import signal
import sys
import time
from typing import Any, Dict, List, Optional

import dotenv
from scrapy.crawler import CrawlerProcess
from scrapy.utils.project import get_project_settings
from supabase import create_client

from scrapy_worker.pipelines import collect_state
from scrapy_worker.spiders.email_spider import EmailSpider

dotenv.load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
MAX_CONCURRENCY = int(os.environ.get("MAX_CONCURRENCY", "4"))  # Worker processes (parallel jobs)
MAX_STORED_VISITED_URLS = max(1, int(os.environ.get("MAX_STORED_VISITED_URLS", "200")))

if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    print("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env", file=sys.stderr)
    sys.exit(1)

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

shutting_down = False
stats = {"processed": 0, "errors": 0, "active": 0}


def normalize_response(
    success: bool, emails: List[str], facebook_urls: List[str], errors: List[Dict]
) -> Dict[str, Any]:
    """Normalize scrape result for DB update."""
    if not success:
        error_msg = errors[0]["error"] if errors else "Scrape failed"
        return {
            "status": "auto_need_google_search",
            "emails": [],
            "facebook_urls": [],
            "message": error_msg,
            "needs_browser_rendering": False,
        }
    has_emails = len(emails) > 0
    return {
        "status": "auto_completed" if has_emails else "auto_need_google_search",
        "emails": emails,
        "facebook_urls": facebook_urls,
        "message": "new py" if has_emails else "No emails found -py",
        "needs_browser_rendering": False,
    }


def run_spider(url: str) -> tuple[bool, List[str], List[str], List[str], List[Dict]]:
    """Run the email spider for a single URL."""
    settings = get_project_settings()
    settings.set("ITEM_PIPELINES", {"scrapy_worker.pipelines.CollectPipeline": 300})
    settings.set("CONCURRENT_REQUESTS", 8)  # Parallel subpage fetches
    settings.set("LOG_LEVEL", "WARNING")
    settings.set("TELNETCONSOLE_ENABLED", False)
    settings.set("PLAYWRIGHT_MAX_CONTEXTS", 8)

    process = CrawlerProcess(settings)
    process.crawl(EmailSpider, url=url)
    process.start()
    process.stop()

    emails = list(collect_state.get("emails", set()))
    fb = list(collect_state.get("fb", set()))
    urls = (collect_state.get("urls", []))[:MAX_STORED_VISITED_URLS]
    errors = collect_state.get("errors", [])
    success = len(errors) == 0 or len(emails) > 0
    return (success, emails, fb, urls, errors)


def process_one_job(row: Dict[str, Any], client) -> None:
    """Process a single job and update DB. Runs in worker process."""
    job_id = row["id"]
    url = row.get("url", "")

    try:
        success, emails, facebook_urls, _crawled_urls, errs = run_spider(url)
        normalized = normalize_response(success, emails, facebook_urls, errs)
        payload = {
            "status": normalized["status"],
            "emails": normalized["emails"],
            "facebook_urls": normalized["facebook_urls"],
            "message": normalized["message"],
            "needs_browser_rendering": normalized["needs_browser_rendering"],
            "scrape_type": "browser_rendering",
        }
    except Exception as err:
        payload = {
            "status": "auto_need_google_search",
            "emails": [],
            "facebook_urls": [],
            "message": str(err) if err else "Unknown error",
            "needs_browser_rendering": False,
            "scrape_type": "browser_rendering",
        }

    try:
        client.table("email_scraper_node").update(payload).eq("id", job_id).execute()
    except Exception as e:
        print(f"[Worker] DB update failed for job {job_id}: {e}", file=sys.stderr)


def worker_process(worker_id: int, shutdown_flag) -> None:
    """Single worker process - fetch 1 job, process, update."""
    local_client = create_client(
        os.environ.get("SUPABASE_URL", ""),
        os.environ.get("SUPABASE_SERVICE_KEY", ""),
    )

    while not shutdown_flag.value:
        try:
            jobs = local_client.rpc(
                "auto_get_next_email_scraper_nodes_need_browser_rendering",
                {"batch_size": 1},
            ).execute()
            rows = jobs.data or []
        except Exception as e:
            print(f"[Worker {worker_id}] Fetch failed: {e}", file=sys.stderr)
            time.sleep(5)
            continue

        if not rows:
            time.sleep(0.5)
            continue

        for row in rows:
            process_one_job(row, local_client)


def main_loop() -> None:
    """Main loop - spawn worker processes."""
    import multiprocessing

    num_workers = max(1, min(MAX_CONCURRENCY, 16))  # Cap at 16
    shutdown = multiprocessing.Value("b", False)

    def on_signal(signum, frame):
        global shutting_down
        shutting_down = True
        shutdown.value = True

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    print(f"Starting {num_workers} worker process(es)")

    try:
        r = (
            supabase.table("email_scraper_node")
            .select("*", count="exact", head=True)
            .eq("status", "auto_need_browser_rendering")
            .execute()
        )
        count = r.count if hasattr(r, "count") and r.count is not None else "?"
        print(f"Startup: {count} jobs queued")
    except Exception as e:
        print(f"Startup check failed: {e}")

    processes = []
    for i in range(num_workers):
        p = multiprocessing.Process(target=worker_process, args=(i, shutdown))
        p.start()
        processes.append(p)

    try:
        for p in processes:
            p.join()
    except KeyboardInterrupt:
        pass
    finally:
        shutdown.value = True
        for p in processes:
            p.terminate()
            p.join(timeout=5)
    print("Goodbye.")


if __name__ == "__main__":
    main_loop()
