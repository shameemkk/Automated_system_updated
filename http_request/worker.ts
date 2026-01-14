
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

// Supabase Client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

// Concurrency Queue
const queue = new PQueue({ concurrency: MAX_CONCURRENCY });

let shuttingDown = false;

// --- UTILITIES ---

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
                finalStatus = 'need_google_search';
            } else {
                finalStatus = 'completed';
            }
        } else if (normalized.needs_browser_rendering) {
            finalStatus = 'need_browser_rendering';
        } else if (normalized.status === 'completed' && !hasEmails) {
            finalStatus = 'need_google_search';
        } else {
            finalStatus = normalized.status;
        }

        // Update DB using Supabase ORM
        const { error } = await supabase
            .from('email_scraper_node')
            .update({
                status: finalStatus,
                emails: normalized.emails,
                facebook_urls: normalized.facebook_urls,
                message: normalized.message,
                needs_browser_rendering: normalized.needs_browser_rendering,
                updated_at: new Date().toISOString()
            })
            .eq('id', row.id);

        if (error) {
            console.error(`[Worker] DB update failed for job ${row.id}:`, error);
            stats.errors++;
        } else if (normalized.status === 'error') {
            stats.errors++;
        } else {
            stats.processed++;
        }

    } catch (err: any) {
        stats.errors++;
        let errorMessage = 'Unknown fatal error';
        if (err instanceof Error) {
            errorMessage = err.message;
        }

        // Error Update - log if this fails too
        const { error: updateError } = await supabase
            .from('email_scraper_node')
            .update({
                status: 'error',
                message: errorMessage,
                updated_at: new Date().toISOString()
            })
            .eq('id', row.id);

        if (updateError) {
            console.error(`[Worker] Failed to update error status for job ${row.id}:`, updateError);
        }

    } finally {
        stats.active--;
        const duration = Date.now() - start;
        console.log(`[Worker] Job ${row.id} finished in ${duration}ms (Active: ${stats.active})`);
    }
}

/**
 * Atomic Claim using RPC
 */
async function fetchAndClaim(slots: number): Promise<any[]> {
    if (slots <= 0) return [];

    // Use RPC 'get_next_urls' to perform the SKIP LOCKED select + update
    const { data, error } = await supabase
        .rpc('get_next_email_scraper_nodes_http_request', { batch_size: slots });

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

    // Startup Check - only count http_request scrape_type
    const { count: queuedCount, error: qErr } = await supabase
        .from('email_scraper_node')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'queued')
        .eq('scrape_type', 'http_request');


    if (qErr) {
        console.error("Startup check failed. Check credentials/connection.", qErr);
    } else {
        console.log(`Startup Status: Queued=${queuedCount}`);

        if ((queuedCount || 0) === 0) {
            console.log('No queued items found. Checking for retryable error jobs...');
            
            // Re-queue error jobs with retry_count <= 2 using RPC
            const { data: retriedCount, error: retryErr } = await supabase
                .rpc('retry_error_jobs_http_request');

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
                            .rpc('retry_error_jobs_http_request');

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
    console.log('Goodbye.');
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

mainLoop().catch(err => {
    console.error('Fatal crash:', err);
    process.exit(1);
});
