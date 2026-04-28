# Email Verification Worker

A long-running TypeScript worker that consumes rows from the `email_scraper_node` table, verifies the harvested email addresses against external providers, and writes the results back to Supabase. Designed to run as a single PM2 / Docker process with a high concurrency in-memory queue.

---

## Table of Contents
1. [What it does](#what-it-does)
2. [End-to-end Workflow](#end-to-end-workflow)
3. [Project Structure](#project-structure)
4. [Configuration](#configuration)
5. [Database Requirements](#database-requirements)
6. [Running Locally](#running-locally)
7. [Running in Docker](#running-in-docker)
8. [Local Test Harness](#local-test-harness)
9. [Status / Mode Vocabulary](#status--mode-vocabulary)
10. [Operational Notes](#operational-notes)
11. [Troubleshooting](#troubleshooting)

---

## What it does

For each `email_scraper_node` row in status `auto_completed`, the worker:

1. **Deduplicates** the row's `emails` array (lowercase + unique).
2. **Prioritizes** emails matching facility-management / decision-maker keywords (owner, founder, fm, maintenance, ops, etc.) and **keeps the top 5**.
3. **Classifies each domain** as Microsoft-ESP or not (free-mail domains skip this step). Microsoft-ESP detection uses Google DNS MX lookup.
4. **Verifies non-Microsoft emails** through [Million Verifier](https://www.millionverifier.com/). On a `catch_all` result, falls back to [TryKitt](https://trykitt.ai/).
5. **Writes results back** to two tables:
   - `email_scraper_node` — `verified_emails`, `rejected_emails`, `status='auto_final_completed'`
   - `client_query_results` — merges verified emails and updates `mode` + `gpt_process` flags so downstream workers can pick the row up.

Microsoft-ESP emails are intentionally **skipped** during verification (they tend to return false negatives at the Million Verifier API).

---

## End-to-end Workflow

```
                 ┌────────────────────────────────────┐
                 │  email_scraper_node (Supabase)     │
                 │  status='auto_completed'           │
                 │  mode='auto'                       │
                 └──────────────┬─────────────────────┘
                                │
                                ▼
                 ┌────────────────────────────────────┐
                 │  RPC fetch_email_verification_     │
                 │  records(batch_size)               │
                 │  • SELECT ... FOR UPDATE SKIP      │
                 │    LOCKED                          │
                 │  • UPDATE status='e_v_processing'  │
                 └──────────────┬─────────────────────┘
                                │
                                ▼
                 ┌────────────────────────────────────┐
                 │  PQueue (max 150 concurrent)       │
                 └──────────────┬─────────────────────┘
                                │ for each row
                                ▼
            ┌──────────────────────────────────────────────┐
            │  processRow(row)                             │
            │                                              │
            │  dedupeEmails ──► prioritizeAndLimitEmails   │
            │             (top 5 by priority keywords)     │
            │                       │                      │
            │                       ▼                      │
            │  getAllUniqueDomainsFromEmails               │
            │                       │                      │
            │                       ▼                      │
            │  build domainESPMap                          │
            │  • free-mail domain ─► not Microsoft         │
            │  • else Google DNS MX ─► isMicrosoftESP      │
            │                       │                      │
            │                       ▼                      │
            │  for each email:                             │
            │  ┌─ Microsoft  ─► skip                       │
            │  └─ other      ─► Million Verifier           │
            │                    │                         │
            │              ┌─────┴─────┬───────────┐       │
            │              │           │           │       │
            │           result=ok  catch_all   anything    │
            │              │           │        else       │
            │              │           ▼           │       │
            │              │      TryKitt          │       │
            │              │           │           │       │
            │              ▼           ▼           ▼       │
            │         verified    valid?       rejected    │
            │                                              │
            └──────────────────────┬───────────────────────┘
                                   │
            ┌──────────────────────┴───────────────────────┐
            │  Write back                                  │
            │  • client_query_results (matched by website  │
            │    + automation_id)                          │
            │      mode='auto_email_verified',             │
            │      gpt_process='auto_queued'               │
            │      OR                                      │
            │      mode='auto_completed_no_valid_emails',  │
            │      gpt_process='auto_completed'            │
            │  • email_scraper_node                        │
            │      status='auto_final_completed'           │
            │      verified_emails / rejected_emails       │
            └──────────────────────────────────────────────┘
```

The main loop runs forever, polling the RPC whenever queue capacity is available, with exponential backoff (1s → 60s) when no rows are returned.

---

## Project Structure

```
email_verification/
├── src/
│   ├── index.ts        # Entry point: signal handlers + start mainLoop
│   ├── config.ts       # env vars + constants + supabase client + queue + stats + shutdown flag
│   ├── api.ts          # External HTTP clients: Million Verifier, TryKitt, Google DNS MX
│   ├── utils.ts        # Pure helpers: sleep, isMicrosoftESP, dedupe / prioritize / domain extraction
│   └── worker.ts       # processRow + fetchAndClaim + mainLoop + gracefulShutdown
├── test/
│   ├── supabase-stub.ts # In-memory store + supabase.rpc/.from method overrides (no Supabase needed)
│   ├── fixtures.ts      # Seed scraperRows + clientResults covering 7 scenarios
│   └── run-test.ts      # Entry: env bootstrap, install stub, seed, run scenarios, dump state
├── tsconfig.json       # ES2022 + bundler resolution; strict
├── package.json        # tsx-based start / dev scripts
├── Dockerfile          # Node 20 alpine; runs `npm start`
├── fetch_records_rpc.sql  # PG function the worker depends on
├── .env                # NOT committed — provides runtime secrets
└── .gitignore
```

### Module boundaries

| File | Responsibility | Key exports |
|------|----------------|-------------|
| `src/index.ts` | Process bootstrap. Wires `SIGINT`/`SIGTERM` to `gracefulShutdown` and starts `mainLoop`. | — |
| `src/config.ts` | Loads `.env`, validates required vars (exits with code 1 if missing), defines tunables and constants, builds the Supabase client + PQueue, holds shared stats and shutdown flag. | `supabase`, `queue`, `stats`, `MAX_CONCURRENCY`, `EXTERNAL_API_TIMEOUT`, `FREE_EMAIL_DOMAINS`, `MICROSOFT_ESP_DOMAINS`, `PRIORITY_KEYWORDS`, `isShuttingDown`, `setShuttingDown` |
| `src/api.ts` | All outbound HTTP. Each function wraps one provider and handles its own logging on error. | `verifyEmail`, `verifyEmailWithTryKitt`, `resolveMxRecord` |
| `src/utils.ts` | Pure, side-effect-free helpers used by `processRow`. | `sleep`, `isMicrosoftESP`, `dedupeEmails`, `prioritizeAndLimitEmails`, `getAllUniqueDomainsFromEmails` |
| `src/worker.ts` | The full pipeline: per-row processing, RPC-based claim of new work, main loop with backoff, graceful shutdown that drains the queue. | `processRow`, `mainLoop`, `gracefulShutdown` |

---

## Configuration

### `.env` (required, not committed)

Place at `email_verification/.env`. The worker calls `dotenv.config()` at startup and **exits with code 1** if any of the four are missing or empty.

| Variable | Required | Purpose |
|----------|----------|---------|
| `SUPABASE_URL` | yes | Project URL, e.g. `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | yes | Service-role key (needs row-level write + RPC execute) |
| `MILLION_VERIFIER_API_KEY` | yes | API key for [millionverifier.com](https://www.millionverifier.com/) — used as both the `?api=` query string in the URL and the `api_key` param. |
| `TRYKITT_API_KEY` | yes | API key for [trykitt.ai](https://trykitt.ai/) (used as `x-api-key` header) |

Example:
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOi...
MILLION_VERIFIER_API_KEY=...
TRYKITT_API_KEY=...
```

### Compile-time tunables (`src/config.ts`)

These are constants in source, not env-vars. Edit them directly if you need to retune:

| Constant | Default | Notes |
|----------|---------|-------|
| `MAX_CONCURRENCY` | `150` | PQueue concurrency. The inline comment says "6 req/sec" but the active value is 150 — adjust if your provider quota is lower. |
| `EXTERNAL_API_TIMEOUT` | `300_000` ms | Per-request timeout for Million Verifier, TryKitt, and Google DNS. |
| `FREE_EMAIL_DOMAINS` | gmail / yahoo / icloud / proton / etc. | Domains skipped from MX-based ESP classification. |
| `MICROSOFT_ESP_DOMAINS` | outlook / office365 / hotmail / microsoft | Substring matches on the JSON-stringified MX response. |
| `PRIORITY_KEYWORDS` | facility / fm / owner / founder / director … | Regex used to sort priority emails to the front before slicing to top 5. |

### TypeScript / runtime config

| File | Purpose |
|------|---------|
| `tsconfig.json` | Required because `package.json` has `"type": "module"`. Uses `moduleResolution: "bundler"` and `allowImportingTsExtensions: true` so `.ts` imports work directly under `tsx`. `noEmit: true` — we never emit JS, `tsx` runs the TypeScript directly. |
| `package.json` → `type: "module"` | Project is ESM. Imports inside `src/` use explicit `.ts` extensions. |
| `package.json` → `start` / `dev` | `npx tsx src/index.ts` (dev adds `watch`). |

### Files NOT to edit

- `not_edit_template_worker.ts` — historical scaffold kept for reference; `.gitignore`d.
- `node_modules/`, `package-lock.json` — managed by npm.

---

## Database Requirements

The worker depends on **three** database objects in your Supabase / Postgres instance.

### 1. `email_scraper_node` table

Required columns (subset; the table likely has more):

| Column | Type | Used by worker |
|--------|------|----------------|
| `id` | `bigint` PK | claim + final update |
| `emails` | `text[]` | source emails to verify |
| `url` | `text` | join key into `client_query_results.website` |
| `automation_id` | `bigint` | join key into `client_query_results.automation_id` |
| `status` | `text` | claim filter / state machine |
| `mode` | `text` | claim filter (only `mode='auto'` rows are surfaced in the startup count) |
| `verified_emails` | `text[]` | written by worker |
| `rejected_emails` | `jsonb` | written by worker — object of `{ email: rejection_reason }` (see [Rejection reasons](#rejection-reasons)) |
| `updated_at` | `timestamptz` | bumped by the RPC |

### 2. `client_query_results` table

Required columns:

| Column | Type | Used by worker |
|--------|------|----------------|
| `id` | PK | update target |
| `website` | `text` | matched against `email_scraper_node.url` |
| `automation_id` | `bigint` | matched against `email_scraper_node.automation_id` |
| `verified_emails` | `text[]` | merged + written |
| `mode` | `text` | written |
| `gpt_process` | `text` | written |

### 3. RPC `fetch_email_verification_records(batch_size integer)`

Defined in [`fetch_records_rpc.sql`](./fetch_records_rpc.sql). **Apply this once** to your Supabase instance before running the worker:

```bash
psql "$SUPABASE_DB_URL" -f fetch_records_rpc.sql
```
or paste it into the Supabase SQL editor.

The function atomically selects up to `batch_size` rows in `status='auto_completed'` with `FOR UPDATE SKIP LOCKED`, flips them to `e_v_processing`, and returns `(record_id, emails, url, automation_id)`. This is what makes the worker safe to run as multiple replicas.

---

## Running Locally

Prerequisites:
- Node.js 20+
- npm
- A populated `.env` (see above)
- The RPC and tables provisioned in your Supabase project

```bash
cd email_verification
npm install
npm run start          # one-shot
npm run dev            # auto-restart on file changes
```

Optional type check:
```bash
npx tsc --noEmit
```

You should see:
```
Starting worker with max concurrency: 150
Startup Status: completed=<n>
Queue empty. Waiting 1000ms...      # if no work
```

Stop with `Ctrl+C` — the worker drains in-flight jobs, prints `Goodbye.`, then exits cleanly.

---

## Running in Docker

```bash
cd email_verification
docker build -t email-verification .
docker run --rm --env-file .env email-verification
```

`Dockerfile` summary:
- `FROM node:20-alpine`
- `npm install`
- `COPY tsconfig.json` + `COPY src/ ./src/`
- `CMD ["npm", "start"]`

For long-running deployments, prefer running with PM2 / systemd / Kubernetes so the supervisor restarts the container on the `process.exit(1)` paths (missing env, fatal crash).

---

## Local Test Harness

The `test/` directory provides a runnable harness that exercises the **real** `processRow` and `mainLoop` against in-memory dummy rows in place of `email_scraper_node` and `client_query_results` — **no Supabase connection required**. The Million Verifier, TryKitt, and Google DNS calls go out for real, so the worker's verifier integrations are exercised end-to-end against your own API keys.

### Files

| File | Purpose |
|------|---------|
| `test/supabase-stub.ts` | Exports `store` (in-memory `scraperRows` + `clientResults` arrays) and `installSupabaseStub()` which mutates `supabase.rpc` and `supabase.from` to read/write the in-memory store. The chainable shim only implements the methods the worker actually uses; anything else throws. |
| `test/fixtures.ts` | `seedScraperRows` + `seedClientResults` covering 7 scenarios: free-mail mix, catch-all → TryKitt fallback, invalid syntax, Microsoft-ESP skip, unmatched `client_query_results`, empty `emails`, and priority-keyword sort with 8+ candidates. Edit these to use addresses you actually want to verify. |
| `test/run-test.ts` | Entry point. Stubs `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` (dummy values — never used because the stub takes over), loads the real `MILLION_VERIFIER_API_KEY` / `TRYKITT_API_KEY` from `.env`, installs the stub, seeds the store, runs scenarios, dumps the final store state. |

### Prerequisites

- `email_verification/.env` must contain real `MILLION_VERIFIER_API_KEY` and `TRYKITT_API_KEY`. The script aborts with a clear message if they're missing.
- `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` may be present or not — the test stubs them either way.
- `npm install` (only if `node_modules` is missing).

### Running

```bash
cd email_verification

# Scenario mode: process each seeded row directly via processRow()
npm test

# Loop mode: start mainLoop(), let it claim a batch, then shut down gracefully
npm run test:loop
```

Both modes finish by printing the full in-memory store as JSON, so you can inspect:
- `email_scraper_node.status` (every row should end at `auto_final_completed`)
- `email_scraper_node.verified_emails` / `rejected_emails` (with the new `{ email: reason }` format)
- `client_query_results.mode` / `gpt_process` (only matched rows are touched)

### Cost note

Each non-Microsoft, non-empty seed row sends up to 5 emails to Million Verifier. With the default 7 fixtures, the worst-case spend is ~30 Million Verifier calls plus however many catch-alls fall through to TryKitt. Microsoft-ESP rows and the empty-emails row cost nothing.

---

## Status / Mode Vocabulary

These are the exact string values written to the database. Downstream consumers depend on them.

### `email_scraper_node.status`
| Value | Meaning |
|-------|---------|
| `auto_completed` | input — eligible for this worker |
| `e_v_processing` | claimed by a worker (set by the RPC) |
| `auto_final_completed` | finished successfully |
| `e_v_error` | unhandled exception during processing |

### `client_query_results.mode`
| Value | Meaning |
|-------|---------|
| `auto_email_verified` | at least one verified email written |
| `auto_completed_no_valid_emails` | none of the candidate emails verified |

### `client_query_results.gpt_process`
| Value | Meaning |
|-------|---------|
| `auto_queued` | ready for the GPT step |
| `auto_completed` | terminal — no work for the GPT step |

---

## Operational Notes

- **Multiple replicas** are safe because claiming is done via `FOR UPDATE SKIP LOCKED` inside the RPC — two workers will never claim the same row.
- **Backoff** starts at 1s and doubles up to 60s when the queue is empty; resets to 1s as soon as a batch is claimed.
- **Stats** (`processed`, `errors`, `active`) are kept in-memory only and printed on every row finish. There is no Prometheus / external metrics emitter — wire one in if you need observability.
- **Microsoft skip** is a deliberate cost-saver: those addresses are not pushed to either verifier. They are recorded in `rejected_emails` with reason `skipped_microsoft_esp` so downstream can distinguish them from addresses that actually failed verification. **Important**: do not use `rejected_emails` as a do-not-contact list without filtering out this reason — those mailboxes may be valid; the verifier just isn't reliable on Microsoft-hosted domains.
- **TryKitt fallback** is only attempted when Million Verifier returns `result === 'catch_all'`. Other negative results (`invalid`, `disposable`, `unknown`, etc.) go straight to `rejected_emails`.

### Rejection reasons

`rejected_emails` is a `jsonb` object mapping each rejected email to a short reason string. All reasons follow the format `<provider>:<verdict>[:<detail>]` so consumers can split on `:` to parse:

| Reason | When | Example |
|--------|------|---------|
| `system:skipped_microsoft_esp` | Domain MX matched Microsoft — verifier intentionally bypassed | `system:skipped_microsoft_esp` |
| `mv:<result>[:<subresult>]` | Million Verifier returned a non-`ok`, non-`catch_all` verdict | `mv:invalid`, `mv:invalid:disposable` |
| `mv:error:<message>` | Million Verifier call threw (timeout, network error, etc.) | `mv:error:timeout of 300000ms exceeded` |
| `trykitt:<validity>[:<reason>]` | TryKitt fallback rejected a catch-all | `trykitt:invalid`, `trykitt:invalid:smtp rejected` |
| `trykitt:error:<message>` | TryKitt call threw | `trykitt:error:ECONNRESET` |

---

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env` and exit | `.env` not present or vars empty. |
| `Missing MILLION_VERIFIER_API_KEY` / `Missing TRYKITT_API_KEY` and exit | Same — set those keys before starting. |
| `Error fetching rows via RPC` | RPC `fetch_email_verification_records` not deployed, or the service-role key lacks `EXECUTE` permission. Re-run [`fetch_records_rpc.sql`](./fetch_records_rpc.sql). |
| Logs show `No matching client_query_results found for URL` | `email_scraper_node.url` does not match any `client_query_results.website` for the same `automation_id`. Confirm both rows were created by the upstream pipeline with consistent URLs. |
| Rows stuck in `e_v_processing` | A previous worker crashed mid-flight. Manually reset to `auto_completed`: `UPDATE email_scraper_node SET status='auto_completed' WHERE status='e_v_processing' AND updated_at < now() - interval '1 hour';` |
| Million Verifier rate-limit errors | Lower `MAX_CONCURRENCY` in `src/config.ts`. The inline comment ("Rate limit: 6 req/sec") is a hint about the upstream limit even though the constant currently runs at 150. |
| `tsc --noEmit` errors after edits | Make sure `.ts` extension is included on every relative import inside `src/` — `allowImportingTsExtensions` is enabled and required. |
