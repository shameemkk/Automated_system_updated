import { createClient } from '@supabase/supabase-js';
import PQueue from 'p-queue';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const OUTSCRAPER_API_KEY = process.env.OUTSCRAPER_API_KEY || '';
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '5', 10);
const API_CALL_DELAY = parseInt(process.env.API_CALL_DELAY || '2000', 10);
const EXTERNAL_API_TIMEOUT = 300000; // 5 minutes
const POLL_DELAY = 5000; // 5 seconds between status checks
const DEBUG = process.env.DEBUG === 'true';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
    process.exit(1);
}
if (!OUTSCRAPER_API_KEY) {
    console.error('Missing OUTSCRAPER_API_KEY in .env');
    process.exit(1);
}

// Stats
const stats = {
    processed: 0,
    errors: 0,
    active: 0,
    pending: 0
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

// Basic email regex: local@domain.tld (no consecutive dots, no query params)
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

function normalizeAndValidateEmail(raw: string): string | null {
    if (!raw || typeof raw !== 'string') return null;
    let s = raw.trim();
    if (!s) return null;

    // Strip mailto: prefix if present
    if (s.toLowerCase().startsWith('mailto:')) {
        s = s.slice(7).trim();
    }
    // Strip query string (?subject=, ?body=, etc.)
    const qIdx = s.indexOf('?');
    if (qIdx !== -1) s = s.slice(0, qIdx).trim();
    // Take only the part before common delimiters (e.g. "email  |  TDLR #C2515")
    const pipeIdx = s.indexOf('|');
    if (pipeIdx !== -1) s = s.slice(0, pipeIdx).trim();
    s = s.trim().toLowerCase();
    if (!s) return null;

    // Reject invalid patterns
    if (/\.\./.test(s)) return null;           // consecutive dots (e.g. co.hays..tx.us)
    if (/[?#&%]/.test(s)) return null;         // leftover query/encoded chars
    if (!EMAIL_REGEX.test(s)) return null;

    return s;
}

// Extract emails from Outscraper API response
function extractEmails(data: any): string[] {
    const emails: Set<string> = new Set();

    if (!data || !Array.isArray(data)) return [];

    for (const item of data) {
        if (item.emails && Array.isArray(item.emails)) {
            for (const emailObj of item.emails) {
                if (emailObj.value && typeof emailObj.value === 'string') {
                    const cleaned = normalizeAndValidateEmail(emailObj.value);
                    if (cleaned) emails.add(cleaned);
                }
            }
        }
    }

    return Array.from(emails);
}

// Check pending job status using stored request ID
async function checkPendingJob(row: any): Promise<void> {
    const start = Date.now();
    
    try {
        // Extract request ID from message
        const requestIdMatch = row.message?.match(/Outscraper request initiated: (.+)/);
        if (!requestIdMatch) {
            throw new Error('No request ID found in pending job message');
        }
        
        const requestId = requestIdMatch[1];
        console.log(`[Worker] Checking pending job ${row.id} with request ID: ${requestId}`);

        const statusResponse = await checkOutscraperStatus(requestId);
        
        if (statusResponse.status === 'Success' && statusResponse.data) {
            // Extract emails and complete the job
            const emails = extractEmails(statusResponse.data);
            console.log(`[Worker] Pending job ${row.id} completed - found ${emails.length} emails`);

            await supabase
                .from('email_scraper_node')
                .update({
                    status: 'auto_completed',
                    emails: emails,
                    message: `Outscraper completed: ${emails.length} emails found`,
                    scrape_type: 'outscraper',
                    
                })
                .eq('id', row.id);

            stats.processed++;
            stats.pending--;
        } else if (statusResponse.status === 'Pending') {
            // Still in outscraper_pending. mark pending, The timestamp will be automatically updated in the database to prevent re-checking too soon.
            await supabase
                .from('email_scraper_node')
                .update({
                    status: 'outscraper_pending'
                })
                .eq('id', row.id);
            
            console.log(`[Worker] Job ${row.id} still outscraper_pending, updated timestamp`);
        } else {
            // Failed or unknown status
            throw new Error(`Outscraper request failed with status: ${statusResponse.status}`);
        }

    } catch (err: any) {
        stats.errors++;
        if (stats.pending > 0) stats.pending--;
        
        let errorMessage = 'Unknown error checking pending job';
        if (axios.isAxiosError(err)) {
            errorMessage = err.message;
            if (err.code === 'ECONNABORTED') errorMessage = 'Timeout checking status';
            if (err.response) {
                const apiError = err.response.data?.message || JSON.stringify(err.response.data);
                errorMessage = `API Error ${err.response.status}: ${apiError}`;
            }
        } else if (err instanceof Error) {
            errorMessage = err.message;
        }

        console.error(`[Worker] Pending job ${row.id} failed: ${errorMessage}`);

        await supabase
            .from('email_scraper_node')
            .update({
                status: 'outscraper_error',
                message: errorMessage,
                retry_count: (row.retry_count || 0) + 1,
                scrape_type: 'outscraper',
                
            })
            .eq('id', row.id);
    } finally {
        const duration = Date.now() - start;
        console.log(`[Worker] Pending job ${row.id} check finished in ${duration}ms`);
    }
}

// Fetch stale pending jobs (updated_at > 2 minutes ago)
async function fetchStalePendingJobs(slots: number): Promise<any[]> {
    if (slots <= 0) return [];

    const { data, error } = await supabase
        .rpc('get_stale_pending_jobs', { batch_size: slots });

    if (error) {
        console.error('Error fetching stale pending jobs:', error);
        return [];
    }

    if (DEBUG && data && data.length > 0) {
        console.log(`Fetched ${data.length} stale pending jobs`);
    }

    return data || [];
}

// --- CORE WORKER LOGIC ---

async function initiateOutscraperRequest(url: string): Promise<string> {
    const apiUrl = `https://api.app.outscraper.com/emails-and-contacts`;
    
    const response = await axios.get(apiUrl, {
        params: {
            query: url
        },
        headers: {
            'X-API-KEY': OUTSCRAPER_API_KEY
        },
        timeout: EXTERNAL_API_TIMEOUT
    });

    if (DEBUG) {
        console.log('Outscraper initiate response:', response.data);
    }

    if (!response.data || !response.data.id) {
        throw new Error('Invalid response from Outscraper API - missing id');
    }

    return response.data.id;
}

async function checkOutscraperStatus(requestId: string): Promise<any> {
    const apiUrl = `https://api.outscraper.cloud/requests/${requestId}`;
    
    const response = await axios.get(apiUrl, {
        timeout: EXTERNAL_API_TIMEOUT
    });

    if (DEBUG) {
        console.log('Outscraper status response:', response.data);
    }

    return response.data;
}

async function processRow(row: any) {
    stats.active++;
    const start = Date.now();

    try {
        await sleep(API_CALL_DELAY);

        console.log(`[Worker] Processing job ${row.id} for URL: ${row.url}`);

        // Step 1: Initiate Outscraper request
        const requestId = await initiateOutscraperRequest(row.url);
        console.log(`[Worker] Job ${row.id} - Outscraper request initiated with ID: ${requestId}`);

        // Update status to outscraper_pending with request ID
        await supabase
            .from('email_scraper_node')
            .update({
                status: 'outscraper_pending',
                message: `Outscraper request initiated: ${requestId}`,
                scrape_type: 'outscraper',
                
            })
            .eq('id', row.id);

        stats.pending++;

        // Step 2: Check status once after a short delay
        await sleep(POLL_DELAY);
        
        try {
            const statusResponse = await checkOutscraperStatus(requestId);
            
            if (statusResponse.status === 'Success' && statusResponse.data) {
                // Extract emails and complete immediately
                const emails = extractEmails(statusResponse.data);
                console.log(`[Worker] Job ${row.id} - Outscraper request completed immediately with ${emails.length} emails`);

                await supabase
                    .from('email_scraper_node')
                    .update({
                        status: 'auto_completed',
                        emails: emails,
                        message: `Outscraper completed: ${emails.length} emails found`,
                        scrape_type: 'outscraper',
                        
                    })
                    .eq('id', row.id);

                stats.processed++;
                stats.pending--;
            } else {
                // Still pending or any other status - leave as outscraper_pending for later processing
                console.log(`[Worker] Job ${row.id} - Status: ${statusResponse.status}, leaving as outscraper_pending for later check`);
                // Status already set to outscraper_pending above, no need to update again
            }
        } catch (statusError: any) {
            // If status check fails, leave it as outscraper_pending for later retry
            console.log(`[Worker] Job ${row.id} - Status check failed, leaving as outscraper_pending: ${statusError.message}`);
        }

    } catch (err: any) {
        stats.errors++;
        if (stats.pending > 0) stats.pending--;
        
        let errorMessage = 'Unknown fatal error';
        if (axios.isAxiosError(err)) {
            errorMessage = err.message;
            if (err.code === 'ECONNABORTED') errorMessage = 'Timeout';
            if (err.response) {
                const apiError = err.response.data?.message || JSON.stringify(err.response.data);
                errorMessage = `API Error ${err.response.status}: ${apiError}`;
            }
        } else if (err instanceof Error) {
            errorMessage = err.message;
        }

        console.error(`[Worker] Job ${row.id} failed: ${errorMessage}`);

        await supabase
            .from('email_scraper_node')
            .update({
                status: 'outscraper_error',
                message: errorMessage,
                retry_count: (row.retry_count || 0) + 1,
                scrape_type: 'outscraper',
                
            })
            .eq('id', row.id);

    } finally {
        stats.active--;
        const duration = Date.now() - start;
        console.log(`[Worker] Job ${row.id} finished in ${duration}ms (Active: ${stats.active}, Pending: ${stats.pending})`);
    }
}

async function fetchAndClaim(slots: number): Promise<any[]> {
    if (slots <= 0) return [];

    // First, fetch available jobs
    const { data, error } = await supabase
        .from('email_scraper_node')
        .select('*')
        .eq('status', 'auto_need_outscraper')
        .order('created_at', { ascending: true })
        .limit(slots);

    if (error) {
        console.error('Error fetching outscraper jobs:', error);
        return [];
    }

    if (!data || data.length === 0) {
        return [];
    }

    // Claim the jobs by updating their status to processing
    const ids = data.map(row => row.id);
    const { error: updateError } = await supabase
        .from('email_scraper_node')
        .update({
            status: 'auto_processing',
            scrape_type: 'outscraper',
            
        })
        .in('id', ids);

    if (updateError) {
        console.error('Error claiming outscraper jobs:', updateError);
        return [];
    }

    if (DEBUG && data.length > 0) {
        console.log(`Fetched and claimed ${data.length} outscraper jobs`);
    }

    return data;
}

async function mainLoop() {
    let backoffMs = 1000;
    const maxBackoff = 60000;

    console.log(`Starting Outscraper worker with max concurrency: ${MAX_CONCURRENCY}`);

    // Startup check
    const { count: queuedCount, error: qErr } = await supabase
        .from('email_scraper_node')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'auto_need_outscraper');

    if (qErr) {
        console.error("Startup check failed.", qErr);
    } else {
        console.log(`Startup Status: queued outscraper jobs=${queuedCount}`);
    }

    while (!shuttingDown) {
        try {
            const currentPending = queue.pending;
            const slotsAvailable = MAX_CONCURRENCY - currentPending;

            if (slotsAvailable > 0) {
                // Priority 1: Process new queued jobs
                const jobs = await fetchAndClaim(slotsAvailable);

                if (jobs.length > 0) {
                    backoffMs = 1000;
                    console.log(`Claimed ${jobs.length} new outscraper jobs.`);
                    jobs.forEach(row => {
                        queue.add(() => processRow(row));
                    });
                } else {
                    // Priority 2: Check stale pending jobs (updated_at > 2 minutes ago)
                    const pendingJobs = await fetchStalePendingJobs(slotsAvailable);
                    
                    if (pendingJobs.length > 0) {
                        backoffMs = 1000;
                        console.log(`Processing ${pendingJobs.length} stale pending jobs.`);
                        pendingJobs.forEach(row => {
                            queue.add(() => checkPendingJob(row));
                        });
                    } else {
                        // Priority 3: Retry error jobs when queue is completely empty
                        if (queue.size === 0 && queue.pending === 0) {
                            const { data: errorJobs, error: errErr } = await supabase
                                .from('email_scraper_node')
                                .select('*')
                                .eq('status', 'outscraper_error')
                                .lt('retry_count', 3)
                                .order('updated_at', { ascending: true })
                                .limit(slotsAvailable);

                            if (!errErr && errorJobs && errorJobs.length > 0) {
                                const ids = errorJobs.map(r => r.id);
                                await supabase
                                    .from('email_scraper_node')
                                    .update({ 
                                        status: 'auto_need_outscraper', 
                                        message: 'Retrying after error',
                                        scrape_type: 'outscraper',
                                        
                                    })
                                    .in('id', ids);
                                console.log(`♻️ Re-queued ${errorJobs.length} outscraper_error jobs for retry.`);
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
                }
            } else {
                await sleep(200);
            }

            // // Log stats periodically
            // if (stats.processed % 10 === 0 && stats.processed > 0) {
            //     console.log(`[Stats] Processed: ${stats.processed}, Errors: ${stats.errors}, Active: ${stats.active}, Pending: ${stats.pending}`);
            // }

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
    console.log(`Final stats - Processed: ${stats.processed}, Errors: ${stats.errors}`);
    console.log('Goodbye.');
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Start the worker
mainLoop().catch(err => {
    console.error('Fatal crash:', err);
    process.exit(1);
});