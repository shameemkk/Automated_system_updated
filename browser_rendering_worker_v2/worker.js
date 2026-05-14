import 'dotenv/config';
import pg from 'pg';

// =========================================================================
// Configuration
// =========================================================================
const API_URLS = (process.env.API_URLS || '')
  .split(',')
  .map(u => u.trim())
  .filter(Boolean);

if (API_URLS.length === 0) {
  console.error('Missing API_URLS env var (comma-separated, e.g. http://server1:3000,http://server2:3000)');
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL || '';
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL env var');
  process.exit(1);
}

const TOTAL_CONCURRENCY = Math.max(1, parseInt(process.env.TOTAL_CONCURRENCY, 10) || 400);
const BATCH_SIZE        = Math.max(1, parseInt(process.env.BATCH_SIZE, 10) || 50);
const API_TIMEOUT_MS    = Math.max(5000, parseInt(process.env.API_TIMEOUT_MS, 10) || 130000);
const POLL_INTERVAL_MS  = Math.max(500, parseInt(process.env.POLL_INTERVAL_MS, 10) || 1000);
const MAX_BACKOFF_MS    = Math.max(1000, parseInt(process.env.MAX_BACKOFF_MS, 10) || 60000);

// Per-endpoint concurrency — evenly distributed
const PER_ENDPOINT = Math.max(1, Math.floor(TOTAL_CONCURRENCY / API_URLS.length));

// =========================================================================
// PostgreSQL pool
// =========================================================================
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('[PG Pool] Unexpected error:', err.message));

// =========================================================================
// Per-endpoint state — tracks in-flight count per API server
// =========================================================================
const endpoints = API_URLS.map((url) => ({
  url: url.replace(/\/+$/, ''),
  active: 0,
  total: 0,
  errors: 0,
}));

// Round-robin cursor for tie-breaking
let rrCursor = 0;

/**
 * Pick the endpoint with the fewest active requests (least-loaded).
 * Ties are broken by round-robin to avoid starvation.
 */
function pickEndpoint() {
  let best = null;
  let bestActive = Infinity;
  const len = endpoints.length;

  for (let i = 0; i < len; i++) {
    const idx = (rrCursor + i) % len;
    const ep = endpoints[idx];
    if (ep.active < bestActive) {
      bestActive = ep.active;
      best = ep;
    }
  }
  rrCursor = (rrCursor + 1) % len;
  return best;
}

// =========================================================================
// Stats
// =========================================================================
const stats = { processed: 0, errors: 0, claimed: 0, startedAt: Date.now() };

function printStats() {
  const uptime = ((Date.now() - stats.startedAt) / 1000).toFixed(0);
  const active = endpoints.reduce((s, e) => s + e.active, 0);
  console.log(
    `[Stats] uptime=${uptime}s processed=${stats.processed} errors=${stats.errors} active=${active}/${TOTAL_CONCURRENCY} ` +
    endpoints.map((e, i) => `ep${i}=${e.active}/${PER_ENDPOINT}`).join(' ')
  );
}

// =========================================================================
// Claim jobs from database — atomic SELECT … FOR UPDATE SKIP LOCKED
// =========================================================================
const CLAIM_QUERY = `
  UPDATE email_scraper_node
  SET status = 'auto_processing', updated_at = NOW()
  WHERE id IN (
    SELECT id FROM email_scraper_node
    WHERE status = 'auto_need_browser_rendering'
    ORDER BY created_at ASC
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id, url, emails, facebook_urls;
`;

async function claimJobs(limit) {
  try {
    const { rows } = await pool.query(CLAIM_QUERY, [limit]);
    return rows;
  } catch (err) {
    console.error('[DB] Claim error:', err.message);
    return [];
  }
}

// =========================================================================
// Write result back to database
// =========================================================================
const UPDATE_QUERY = `
  UPDATE email_scraper_node
  SET status = $1,
      emails = $2,
      facebook_urls = $3,
      message = $4,
      needs_browser_rendering = false,
      scrape_type = 'browser_rendering',
      updated_at = NOW()
  WHERE id = $5;
`;

async function saveResult(jobId, normalized) {
  try {
    await pool.query(UPDATE_QUERY, [
      normalized.status,
      normalized.emails,
      normalized.facebook_urls,
      normalized.message,
      jobId,
    ]);
  } catch (err) {
    console.error(`[DB] Update error for job ${jobId}:`, err.message);
  }
}

// =========================================================================
// Call API endpoint
// =========================================================================
async function callApi(endpoint, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const res = await fetch(`${endpoint.url}/extract-emails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// =========================================================================
// Merge two arrays, dedup, drop falsy values, preserve insertion order
// =========================================================================
function mergeUnique(a, b) {
  const set = new Set();
  for (const x of a || []) if (x) set.add(x);
  for (const x of b || []) if (x) set.add(x);
  return [...set];
}

// =========================================================================
// Normalize API response → DB update fields (mirrors old worker logic)
// =========================================================================
function normalizeResponse(apiResult) {
  if (!apiResult || !apiResult.success) {
    const errorMsg = apiResult?.error || apiResult?.message || 'Scrape failed';
    return {
      status: 'auto_need_google_search',
      emails: [],
      facebook_urls: [],
      message: errorMsg,
    };
  }

  const hasEmails = apiResult.emails && apiResult.emails.length > 0;
  return {
    status: hasEmails ? 'auto_completed' : 'auto_need_google_search',
    emails: apiResult.emails || [],
    facebook_urls: apiResult.facebook_urls || [],
    message: hasEmails ? null : 'No emails found',
  };
}

// =========================================================================
// Process a single job
// =========================================================================
async function processJob(job) {
  const endpoint = pickEndpoint();
  endpoint.active++;
  endpoint.total++;
  const start = Date.now();

  const existingEmails = job.emails || [];
  const existingFb = job.facebook_urls || [];

  try {
    const apiResult = await callApi(endpoint, job.url);
    const normalized = normalizeResponse(apiResult);

    normalized.emails = mergeUnique(existingEmails, normalized.emails);
    normalized.facebook_urls = mergeUnique(existingFb, normalized.facebook_urls);

    // Re-derive status: if merged result has emails, treat as completed
    if (normalized.emails.length > 0) {
      normalized.status = 'auto_completed';
      if (normalized.message === 'No emails found') normalized.message = null;
    }

    await saveResult(job.id, normalized);
    stats.processed++;
  } catch (err) {
    stats.errors++;
    endpoint.errors++;
    const message = err.name === 'AbortError' ? 'API request timed out' : err.message;
    console.error(`[Job ${job.id}] ${job.url} → error: ${message}`);

    // Preserve existing emails/fb_urls on API failure
    await saveResult(job.id, {
      status: existingEmails.length > 0 ? 'auto_completed' : 'auto_need_google_search',
      emails: existingEmails,
      facebook_urls: existingFb,
      message: existingEmails.length > 0 ? null : message,
    });
  } finally {
    endpoint.active--;
    const elapsed = Date.now() - start;
    if (elapsed > 5000) {
      console.log(`[Job ${job.id}] ${job.url} finished in ${elapsed}ms`);
    }
  }
}

// =========================================================================
// Main loop — continuously polls for jobs and dispatches them
// =========================================================================
let shuttingDown = false;
const inFlight = new Set();

async function mainLoop() {
  let backoffMs = POLL_INTERVAL_MS;

  console.log('========================================');
  console.log(`Worker starting`);
  console.log(`  API endpoints: ${API_URLS.join(', ')}`);
  console.log(`  Total concurrency: ${TOTAL_CONCURRENCY}`);
  console.log(`  Per-endpoint concurrency: ${PER_ENDPOINT}`);
  console.log(`  Batch size: ${BATCH_SIZE}`);
  console.log(`  API timeout: ${API_TIMEOUT_MS}ms`);
  console.log('========================================');

  // Verify DB connectivity
  try {
    const { rows } = await pool.query(
      `SELECT count(*) AS cnt FROM email_scraper_node WHERE status = 'auto_need_browser_rendering'`
    );
    console.log(`[Startup] ${rows[0].cnt} jobs queued`);
  } catch (err) {
    console.error('[Startup] DB connection failed:', err.message);
    process.exit(1);
  }

  // Verify at least one API endpoint is reachable
  for (const ep of endpoints) {
    try {
      const res = await fetch(`${ep.url}/health`, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      console.log(`[Startup] ${ep.url} → ${data.status || 'OK'}`);
    } catch (err) {
      console.warn(`[Startup] ${ep.url} → unreachable (${err.message})`);
    }
  }

  // Stats printer
  const statsInterval = setInterval(printStats, 30000);

  while (!shuttingDown) {
    try {
      const totalActive = endpoints.reduce((s, e) => s + e.active, 0);
      const slotsAvailable = TOTAL_CONCURRENCY - totalActive;

      if (slotsAvailable <= 0) {
        await sleep(100);
        continue;
      }

      const toFetch = Math.min(slotsAvailable, BATCH_SIZE);
      const jobs = await claimJobs(toFetch);

      if (jobs.length > 0) {
        backoffMs = POLL_INTERVAL_MS;
        stats.claimed += jobs.length;

        for (const job of jobs) {
          // Fire and forget — concurrency is bounded by the claim limit
          const promise = processJob(job).finally(() => inFlight.delete(promise));
          inFlight.add(promise);
        }
      } else {
        // No jobs available — back off exponentially
        if (totalActive === 0) {
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        } else {
          // Still have active jobs, just poll at normal rate
          await sleep(POLL_INTERVAL_MS);
        }
      }
    } catch (err) {
      console.error('[MainLoop] Error:', err.message);
      await sleep(5000);
    }
  }

  clearInterval(statsInterval);

  // Wait for all in-flight jobs to finish
  if (inFlight.size > 0) {
    console.log(`[Shutdown] Waiting for ${inFlight.size} in-flight jobs...`);
    await Promise.allSettled([...inFlight]);
  }
}

// =========================================================================
// Helpers
// =========================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =========================================================================
// Graceful shutdown
// =========================================================================
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);

  // Wait for in-flight to drain (up to 30s)
  const deadline = Date.now() + 30000;
  while (inFlight.size > 0 && Date.now() < deadline) {
    await sleep(500);
  }

  if (inFlight.size > 0) {
    console.warn(`[Shutdown] ${inFlight.size} jobs still in-flight after 30s, forcing exit`);
  }

  printStats();
  await pool.end().catch(() => {});
  console.log('Goodbye.');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

mainLoop().catch((err) => {
  console.error('Fatal crash:', err);
  process.exit(1);
});
