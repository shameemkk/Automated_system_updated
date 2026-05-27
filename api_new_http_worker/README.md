# api_new_http_worker

Queue consumer that pulls `email_scraper_node` jobs from Postgres and routes them to the new HTTP API service documented in [api.md](api.md) (a thin HTTP wrapper around the original [`http_request/`](../http_request) scraping logic).

Runs alongside [`htmlparser_worker`](../htmlparser_worker) on the same queue (`scrape_type='http_request'`); both workers race for jobs via `FOR UPDATE SKIP LOCKED` — no duplicate processing.

## Architecture

```
+---------------------+              +-----------------+
|  email_scraper_node | <-- pg-->    |   this worker   |
|  (Postgres queue)   |              |                 |
+---------------------+              |  worker.ts      |
        ^                            |  +- batcher     |
        | claim/update RPC           |  +- watchdog    |
        |                            |  +- processor --|--> POST /extract-emails
        |                            |     +- api-client --> API instance(s)
        |                            +-----------------+
        |
   +----+----+
   | watchdog|  (leader, reclaims stuck rows)
   +---------+
```

## Job flow

```
auto_queued
   |  claim via auto_get_next_email_scraper_nodes_http_request()
   v
auto_processing
   |
   |  POST /extract-emails to one of HTTP_API_URLS
   |  (load-balanced by lowest in-flight count)
   v
+---------------------+
| decision tree       |
+---------------------+
   |
   +-> hasEmails .................. auto_completed
   +-> hasFacebookUrls only ....... auto_need_google_search
   +-> js_rendered === false ...... auto_need_browser_rendering
   +-> partial timeout, no data ... auto_need_browser_rendering
   +-> success but nothing found .. auto_need_google_search
   +-> 400 bad input .............. auto_error (deterministic, no retry)
   +-> 429/5xx/timeout/network
        | first failure ........... auto_error  (re-queued by retry RPC)
        | retry exhausted ......... auto_need_browser_rendering
```

## Files

| File | Responsibility |
|---|---|
| `worker.ts` | Main loop, p-queue, lifecycle, SIGINT/SIGTERM, periodic stats log |
| `config.ts` | Single source of truth for env vars; fail-fast validation |
| `db.ts` | `pg.Pool` + RPC wrappers (`claimJobs`, `batchUpdate`, `retryErrorJobs`, `reclaimStuckJobs`, `countQueued`, `queueHealth`) + `withRetry` for transient pg errors |
| `api-client.ts` | `axios` POST to `/extract-emails` with multi-target load-balance, per-target cooldown, two-layer timeout, status-code-aware retries, typed `ApiClientError { kind }` |
| `processor.ts` | Per-row decision tree: maps `ScrapeResponse` / `ApiClientError` → DB update |
| `batcher.ts` | Buffered DB updates, periodic + size-triggered flush, requeue-on-failure, back-pressure signals |
| `watchdog.ts` | Leader-elected (`pg_try_advisory_lock`) stuck-row reclaimer + diagnostics |

## Running

```bash
cp .env.example .env       # fill in DATABASE_URL and HTTP_API_URLS
npm install
npm start
```

For development with auto-reload:

```bash
npm run dev
```

### Docker

```bash
docker build -t api_new_http_worker .
docker run --env-file .env api_new_http_worker
```

## Configuration highlights

Default `MAX_CONCURRENCY=150`. Note from [api.md](api.md): one API instance supports ~100 in-flight globally (`HTTP_MAX_CONCURRENCY=10` x `NUM_WORKERS=10`). To run at 150 without queueing requests inside the API event loop, run 2+ API instances and list them in `HTTP_API_URLS`:

```env
HTTP_API_URLS=http://host1:3000,http://host2:3000
```

The client picks the target with the fewest in-flight requests, then by fewest recent failures.

### Timeout chain

```
worker REQUEST_TIMEOUT_MS (default 130s)
  > API's OVERALL_TIMEOUT_MS (default 120s)
      > API's HTTP_TIMEOUT_MS per page (default 30s)
```

A hard `AbortController` kill-switch fires at `REQUEST_TIMEOUT_MS + 5s` so a stuck socket can't wedge a slot.

### Back-pressure

If the update buffer reaches `MAX_PENDING_UPDATES=2000` (e.g., DB unreachable), the worker pauses claiming new jobs until the buffer drains below `RESUME_THRESHOLD=1000`. Already-in-flight jobs continue.

### Shutdown

SIGINT/SIGTERM triggers a bounded graceful shutdown:

1. Stop claiming new jobs.
2. Wait up to `SHUTDOWN_GRACE_MS=30s` for in-flight jobs (`Promise.race(onIdle, sleep)`).
3. Stop the periodic flush timer; release watchdog leadership.
4. Drain `pendingUpdates` to the DB.
5. Close the pg pool, exit 0.

Any in-flight job not finished within the grace period stays in `auto_processing`; the watchdog (any worker) reclaims it after `STUCK_AFTER_MINUTES=10`.

## Known race condition

If a batch update fails and is requeued **and** the watchdog reclaims the row in the same window, the requeued update could overwrite the reset. Mitigated by capping requeue at `BATCH_MAX_FLUSH_RETRIES=3` (max ~30s window) — far below `STUCK_AFTER_MINUTES=10`. A full fix requires adding `WHERE status = 'auto_processing'` to the `auto_batch_update_email_scraper_nodes` RPC in [http_request/schema.sql](../http_request/schema.sql).

## Coexistence with other workers

- Both `htmlparser_worker` and this worker claim from `scrape_type='http_request'` — they load-balance naturally via `FOR UPDATE SKIP LOCKED`.
- Distinct watchdog advisory lock keys (`8472344` for htmlparser_worker, `8472345` here) — both worker pools can run their own watchdog independently without contention.

## Observability

- `[stats]` line every `STATS_LOG_INTERVAL_MS=30s` with: `processed`, `errors`, `escalated`, `active`, `queue size`, `pending_updates`, `dropped`, plus per-target stats.
- `[diag]` from the watchdog leader every `DIAG_INTERVAL_MS=5min` — queue health by status + age, plus per-target totals.
