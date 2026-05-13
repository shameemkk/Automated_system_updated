import PQueue from 'p-queue';
import * as dotenv from 'dotenv';
import {
    pool,
    claimJobs,
    batchUpdate,
    retryErrorJobs,
    countQueued,
    type ScraperRow,
    type PendingUpdate,
} from './db.js';
import { scrapeWebsite } from './scraper.js';
import { normalizeResponse } from './worker-utils.js';
import { startWatchdog, stopWatchdog } from './watchdog.js';

dotenv.config();

// --- CONFIG ---
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '50', 10);
const BATCH_FLUSH_INTERVAL_MS = parseInt(process.env.BATCH_FLUSH_INTERVAL_MS || '10000', 10);
const BATCH_FLUSH_SIZE = parseInt(process.env.BATCH_FLUSH_SIZE || '25', 10);
const BATCH_MAX_FLUSH_RETRIES = 3;
const DEBUG = process.env.DEBUG?.toLowerCase() === 'true';

// --- STATS ---
const stats = {
    processed: 0,
    errors: 0,
    active: 0,
};

// --- BATCH BUFFER ---
interface BufferedUpdate extends PendingUpdate {
    _flushRetries?: number;
}
const pendingUpdates: BufferedUpdate[] = [];

const queue = new PQueue({ concurrency: MAX_CONCURRENCY });
let shuttingDown = false;
let flushIntervalHandle: NodeJS.Timeout | null = null;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// --- BATCH UPDATE LOGIC ---

let activeFlush: Promise<void> | null = null;

async function flushBatchUpdates(): Promise<void> {
    if (activeFlush) {
        await activeFlush;
        return;
    }
    activeFlush = (async () => {
        try {
            if (pendingUpdates.length === 0) return;

            const batch = pendingUpdates.splice(0);
            const cleanBatch: PendingUpdate[] = batch.map(({ _flushRetries, ...rest }) => rest);

            try {
                const affected = await batchUpdate(cleanBatch);
                if (DEBUG) {
                    console.log(`[Worker] Batch updated ${affected}/${batch.length} rows`);
                } else {
                    console.log(`[Worker] Batch updated ${batch.length} rows`);
                }
            } catch (err: any) {
                console.error(`[Worker] Batch update failed for ${batch.length} rows:`, err?.message || err);
                requeueFailedBatch(batch);
            }
        } finally {
            activeFlush = null;
        }
    })();
    return activeFlush;
}

function requeueFailedBatch(batch: BufferedUpdate[]): void {
    const retriable: BufferedUpdate[] = [];
    const dropped: BufferedUpdate[] = [];

    for (const update of batch) {
        const retries = (update._flushRetries || 0) + 1;
        if (retries < BATCH_MAX_FLUSH_RETRIES) {
            retriable.push({ ...update, _flushRetries: retries });
        } else {
            dropped.push(update);
        }
    }

    if (retriable.length > 0) {
        pendingUpdates.push(...retriable);
        console.warn(`[Worker] Re-queued ${retriable.length} updates for retry (attempt ${retriable[0]._flushRetries}/${BATCH_MAX_FLUSH_RETRIES})`);
    }

    if (dropped.length > 0) {
        console.error(`[Worker] Dropped ${dropped.length} updates after ${BATCH_MAX_FLUSH_RETRIES} failed flush attempts. IDs: ${dropped.map(u => u.id).join(', ')}`);
    }
}

// --- CORE WORKER LOGIC ---

async function processRow(row: ScraperRow): Promise<void> {
    stats.active++;
    const start = Date.now();

    try {
        const scrapeResult = await scrapeWebsite(row.url);
        const normalized = normalizeResponse([{ json: scrapeResult }])[0].json;

        const hasEmails = normalized.emails.length > 0;
        const hasFacebookUrls = normalized.facebook_urls.length > 0;
        const hasData = hasEmails || hasFacebookUrls;

        let finalStatus: string;
        let forceNeedsBrowserRendering = false;
        if (normalized.partial && normalized.status !== 'auto_error') {
            finalStatus = normalized.emails.length >= 4
                ? 'auto_completed'
                : 'auto_need_browser_rendering';
        } else if (hasData) {
            finalStatus = hasEmails ? 'auto_completed' : 'auto_need_google_search';
        } else if (normalized.needs_browser_rendering) {
            finalStatus = 'auto_need_browser_rendering';
        } else if (normalized.status === 'auto_completed' && !hasEmails) {
            finalStatus = 'auto_need_google_search';
        } else if (normalized.status === 'auto_error' && row.retry_count >= 1) {
            finalStatus = 'auto_need_browser_rendering';
            forceNeedsBrowserRendering = true;
        } else {
            finalStatus = normalized.status;
        }

        pendingUpdates.push({
            id: row.id,
            status: finalStatus,
            emails: normalized.emails,
            facebook_urls: normalized.facebook_urls,
            message: normalized.message,
            needs_browser_rendering: forceNeedsBrowserRendering || normalized.needs_browser_rendering,
        });

        if (finalStatus === 'auto_error') stats.errors++;
        else stats.processed++;

        if (pendingUpdates.length >= BATCH_FLUSH_SIZE) {
            await flushBatchUpdates();
        }
    } catch (err: any) {
        stats.errors++;
        let errorMessage = 'Unknown fatal error';
        if (err instanceof Error && err.message) errorMessage = err.message;
        else if (err != null) errorMessage = String(err);

        const is429 = errorMessage.includes('HTTP 429');
        const retriesExhausted = row.retry_count >= 1;
        const routeToBrowser = is429 || retriesExhausted;

        pendingUpdates.push({
            id: row.id,
            status: routeToBrowser ? 'auto_need_browser_rendering' : 'auto_error',
            emails: [],
            facebook_urls: [],
            message: errorMessage,
            needs_browser_rendering: routeToBrowser,
        });

        if (pendingUpdates.length >= BATCH_FLUSH_SIZE) {
            await flushBatchUpdates();
        }
    } finally {
        stats.active--;
        const duration = Date.now() - start;
        console.log(`[Worker] Job ${row.id} finished in ${duration}ms (Active: ${stats.active}, Pending: ${pendingUpdates.length})`);
    }
}

// --- MAIN LOOP ---

async function mainLoop(): Promise<void> {
    let backoffMs = 1000;
    const maxBackoff = 60000;

    console.log(`Starting htmlparser_worker — concurrency=${MAX_CONCURRENCY}, batch flush every ${BATCH_FLUSH_INTERVAL_MS}ms or ${BATCH_FLUSH_SIZE} items`);

    await startWatchdog();

    flushIntervalHandle = setInterval(() => {
        flushBatchUpdates().catch(err => console.error('[Worker] Periodic flush error:', err));
    }, BATCH_FLUSH_INTERVAL_MS);

    try {
        const queued = await countQueued();
        console.log(`Startup status: queued=${queued}`);
        if (queued === 0) {
            const retried = await retryErrorJobs();
            if (retried > 0) console.log(`Re-queued ${retried} error jobs at startup`);
        }
    } catch (err) {
        console.error('Startup check failed:', err);
    }

    while (!shuttingDown) {
        try {
            const slotsAvailable = MAX_CONCURRENCY - queue.pending - queue.size;

            if (slotsAvailable > 0) {
                const jobs = await claimJobs(slotsAvailable);

                if (jobs.length > 0) {
                    backoffMs = 1000;
                    console.log(`Claimed ${jobs.length} jobs.`);
                    for (const row of jobs) {
                        queue.add(() => processRow(row));
                    }
                } else if (queue.size === 0 && queue.pending === 0) {
                    const retried = await retryErrorJobs();
                    if (retried > 0) {
                        console.log(`Re-queued ${retried} error jobs.`);
                        backoffMs = 1000;
                        continue;
                    }
                    console.log(`Queue empty. Waiting ${backoffMs}ms...`);
                    await sleep(backoffMs);
                    backoffMs = Math.min(backoffMs * 2, maxBackoff);
                } else {
                    await sleep(1000);
                }
            } else {
                await sleep(200);
            }
        } catch (err) {
            console.error('Main loop error:', err);
            await sleep(5000);
        }
    }
}

// --- SHUTDOWN ---

let shutdownStarted = false;

async function gracefulShutdown(signal: string): Promise<void> {
    if (shutdownStarted) return;
    shutdownStarted = true;

    console.log(`\nReceived ${signal}. Shutting down...`);
    shuttingDown = true;

    if (flushIntervalHandle) {
        clearInterval(flushIntervalHandle);
        flushIntervalHandle = null;
    }

    console.log('Waiting for active jobs to complete...');
    await queue.onIdle();

    while (pendingUpdates.length > 0) {
        const before = pendingUpdates.length;
        console.log(`Flushing ${before} remaining updates...`);
        await flushBatchUpdates();
        if (pendingUpdates.length >= before) {
            console.error(`Shutdown flush stalled: ${pendingUpdates.length} updates unflushable, abandoning. Watchdog will reclaim via auto_processing timeout.`);
            break;
        }
    }

    await stopWatchdog();
    await pool.end().catch(err => console.error('Error closing pool:', err));

    console.log('Goodbye.');
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

mainLoop().catch(err => {
    console.error('Fatal crash:', err);
    process.exit(1);
});
