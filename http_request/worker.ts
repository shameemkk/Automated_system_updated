
import { createClient } from '@supabase/supabase-js';
import PQueue from 'p-queue';
import * as dotenv from 'dotenv';
import { scrapeWebsite } from './scraper.js'; // TypeScript will resolve to scraper.ts
import { normalizeResponse } from './worker-utils.js';

dotenv.config();

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '50', 10);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
    process.exit(1);
}

// Stats
const stats = {
    processed: 0,
    errors: 0,
    active: 0,
    queuedInDb: 0
};

// Batch update types and buffer
interface PendingUpdate {
    id: number;
    status: string;
    emails: string[];
    facebook_urls: string[];
    message: string | null;
    needs_browser_rendering: boolean;
    _flushRetries?: number;  // Track how many times this update failed to flush
}

const pendingUpdates: PendingUpdate[] = [];
const BATCH_FLUSH_INTERVAL_MS = parseInt(process.env.BATCH_FLUSH_INTERVAL_MS || '10000', 10);  // Flush every 10 seconds
const BATCH_FLUSH_SIZE = parseInt(process.env.BATCH_FLUSH_SIZE || '25', 10);           // Or when buffer reaches this size
const BATCH_MAX_FLUSH_RETRIES = 3;  // Max times a failed update is re-queued before dropping

// Supabase Client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    },
    global: {
        fetch: (url, options = {}) => {
            const controller = new AbortController();
            // const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
            
            return fetch(url, {
                ...options,
                signal: controller.signal
            }).finally(() => {
                // clearTimeout(timeoutId);
            });
        }
    }
});

// Concurrency Queue
const queue = new PQueue({ concurrency: MAX_CONCURRENCY });

let shuttingDown = false;

// --- UTILITIES ---

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Retry wrapper for database operations
async function retryDbOperation<T>(operation: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error: any) {
            if (attempt === maxRetries) throw error;
            
            const isConnectionError = error.message?.includes('fetch failed') || 
                                    error.message?.includes('ConnectTimeoutError') ||
                                    error.message?.includes('ECONNRESET');
            
            if (isConnectionError) {
                const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
                console.log(`DB operation failed (attempt ${attempt}/${maxRetries}), retrying in ${backoff}ms...`);
                await sleep(backoff);
            } else {
                throw error; // Non-connection errors should not be retried
            }
        }
    }
    throw new Error('Max retries exceeded');
}

// --- BATCH UPDATE LOGIC ---

async function flushBatchUpdates(): Promise<void> {
    if (pendingUpdates.length === 0) return;

    // Atomically take all pending updates
    const batch = pendingUpdates.splice(0);

    try {
        const { error } = await retryDbOperation(async () => {
            return await supabase.rpc('auto_batch_update_email_scraper_nodes', {
                updates: batch
            });
        });

        if (error) {
            console.error(`[Worker] Batch update failed for ${batch.length} rows:`, error);
            requeueFailedBatch(batch);
        } else {
            console.log(`[Worker] Batch updated ${batch.length} rows`);
        }
    } catch (err) {
        console.error(`[Worker] Batch update exception for ${batch.length} rows:`, err);
        requeueFailedBatch(batch);
    }
}

function requeueFailedBatch(batch: PendingUpdate[]): void {
    const retriable: PendingUpdate[] = [];
    const dropped: PendingUpdate[] = [];

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

async function processRow(row: any) {
    stats.active++;
    const start = Date.now();

    try {
        // Call scrapeWebsite directly instead of HTTP request
        const scrapeResult = await scrapeWebsite(row.url);

        const inputForNormalizer = [{ json: scrapeResult }];
        const normalized = normalizeResponse(inputForNormalizer)[0].json;

        // Determine final status based on results
        const hasEmails = normalized.emails.length > 0;
        const hasFacebookUrls = normalized.facebook_urls.length > 0;
        const hasData = hasEmails || hasFacebookUrls;
        
        let finalStatus: string;
        if (hasData) {
            if (!hasEmails) {
                finalStatus = 'auto_need_google_search';
            } else {
                finalStatus = 'auto_completed';
            }
        } else if (normalized.needs_browser_rendering) {
            finalStatus = 'auto_need_browser_rendering';
        } else if (normalized.status === 'auto_completed' && !hasEmails) {
            finalStatus = 'auto_need_google_search';
        } else {
            finalStatus = normalized.status;
        }

        // Push to batch buffer instead of individual DB update
        pendingUpdates.push({
            id: row.id,
            status: finalStatus,
            emails: normalized.emails,
            facebook_urls: normalized.facebook_urls,
            message: normalized.message,
            needs_browser_rendering: normalized.needs_browser_rendering
        });

        if (normalized.status === 'auto_error') {
            stats.errors++;
        } else {
            stats.processed++;
        }

        // Flush if batch is large enough
        if (pendingUpdates.length >= BATCH_FLUSH_SIZE) {
            await flushBatchUpdates();
        }

    } catch (err: any) {
        stats.errors++;
        let errorMessage = 'Unknown fatal error';
        if (err instanceof Error) {
            errorMessage = err.message;
        }

        // Push error to batch buffer
        pendingUpdates.push({
            id: row.id,
            status: 'auto_error',
            emails: [],
            facebook_urls: [],
            message: errorMessage,
            needs_browser_rendering: false
        });

        // Flush if batch is large enough
        if (pendingUpdates.length >= BATCH_FLUSH_SIZE) {
            await flushBatchUpdates();
        }

    } finally {
        stats.active--;
        const duration = Date.now() - start;
        console.log(`[Worker] Job ${row.id} finished in ${duration}ms (Active: ${stats.active}, Pending: ${pendingUpdates.length})`);
    }
}

/**
 * Atomic Claim using RPC
 */
async function fetchAndClaim(slots: number): Promise<any[]> {
    if (slots <= 0) return [];

    // Use RPC 'get_next_urls' to perform the SKIP LOCKED select + update with retry
    const { data, error } = await retryDbOperation(async () => {
        return await supabase
            .rpc('auto_get_next_email_scraper_nodes_http_request', { batch_size: slots });
    });

    if (error) {
        console.error('Error claiming rows via RPC:', error);
        return [];
    }

    return data || [];
}

async function mainLoop() {
    let backoffMs = 1000;
    const maxBackoff = 60000;

    console.log(`Starting Supabase worker with max concurrency: ${MAX_CONCURRENCY}`);
    console.log(`Batch update: flush every ${BATCH_FLUSH_INTERVAL_MS}ms or every ${BATCH_FLUSH_SIZE} items`);

    // Start periodic batch flush timer
    const flushInterval = setInterval(() => {
        flushBatchUpdates().catch(err => console.error('[Worker] Periodic flush error:', err));
    }, BATCH_FLUSH_INTERVAL_MS);

    // Startup Check - only count http_request scrape_type
    const { count: queuedCount, error: qErr } = await supabase
        .from('email_scraper_node')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'auto_queued')
        .eq('scrape_type', 'http_request');


    if (qErr) {
        console.error("Startup check failed. Check credentials/connection.", qErr);
    } else {
        console.log(`Startup Status: Queued=${queuedCount}`);

        if ((queuedCount || 0) === 0) {
            console.log('No queued items found. Checking for retryable error jobs...');
            
            // Re-queue error jobs with retry_count <= 2 using RPC
            const { data: retriedCount, error: retryErr } = await supabase
                .rpc('auto_retry_error_jobs_http_request');

            if (retryErr) {
                console.error('Error retrying failed jobs:', retryErr);
            } else if (retriedCount && retriedCount > 0) {
                console.log(`♻️ Re-queued ${retriedCount} error jobs for retry.`);
            } else {
                console.warn('\n⚠️ WARNING: No queued or retryable error items found in database.');
            }
        }
    }

    while (!shuttingDown) {
        try {
            const currentPending = queue.pending;
            const slotsAvailable = MAX_CONCURRENCY - currentPending;

            if (slotsAvailable > 0) {
                const jobs = await fetchAndClaim(slotsAvailable);

                if (jobs.length > 0) {
                    backoffMs = 1000;
                    console.log(`Claimed ${jobs.length} jobs.`);
                    jobs.forEach(row => {
                        queue.add(() => processRow(row));
                    });
                } else {
                    if (queue.size === 0 && queue.pending === 0) {
                        // No queued jobs, check for retryable error jobs
                        const { data: retriedCount, error: retryErr } = await supabase
                            .rpc('auto_retry_error_jobs_http_request');

                        if (!retryErr && retriedCount && retriedCount > 0) {
                            console.log(`♻️ Re-queued ${retriedCount} error jobs for retry.`);
                            backoffMs = 1000;
                            continue;
                        }

                        console.log(`Queue empty. Waiting ${backoffMs}ms...`);
                        await sleep(backoffMs);
                        backoffMs = Math.min(backoffMs * 2, maxBackoff);
                    } else {
                        await sleep(1000);
                    }
                }
            } else {
                await sleep(200);
            }
        } catch (error) {
            console.error("Main loop error:", error);
            await sleep(5000);
        }
    }
}

// --- SHUTDOWN HANDLING ---

async function gracefulShutdown(signal: string) {
    console.log(`\nReceived ${signal}. Shutting down...`);
    shuttingDown = true;
    console.log('Waiting for active jobs to complete...');
    await queue.onIdle();
    // Flush any remaining batch updates before exit
    if (pendingUpdates.length > 0) {
        console.log(`Flushing ${pendingUpdates.length} remaining batch updates...`);
        await flushBatchUpdates();
    }
    console.log('Goodbye.');
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

mainLoop().catch(err => {
    console.error('Fatal crash:', err);
    process.exit(1);
});
