import { createClient } from '@supabase/supabase-js';
import PQueue from 'p-queue';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'google-search116.p.rapidapi.com';
const MAX_CONCURRENCY = 6; // Rate limit: 6 req/sec
const EXTERNAL_API_TIMEOUT = 300000;
const API_CALL_DELAY = 170; // ~6 req/sec rate limit

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
    process.exit(1);
}
if (!RAPIDAPI_KEY) {
    console.error('Missing RAPIDAPI_KEY in .env');
    process.exit(1);
}

// Stats
const stats = {
    processed: 0,
    errors: 0,
    active: 0
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

// Extract emails from API response
function extractEmails(data: any[]): string[] {
    const emails: Set<string> = new Set();
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

    if (!Array.isArray(data)) return [];

    for (const item of data) {
        // Search in results descriptions and titles
        if (item.results && Array.isArray(item.results)) {
            for (const result of item.results) {
                const text = `${result.title || ''} ${result.description || ''} ${result.url || ''}`;
                const found = text.match(emailRegex);
                if (found) found.forEach(e => emails.add(e.toLowerCase()));
            }
        }
        // Search in knowledge panel
        if (item.knowledge_panel?.description?.text) {
            const found = item.knowledge_panel.description.text.match(emailRegex);
            if (found) found.forEach((e: string) => emails.add(e.toLowerCase()));
        }
    }

    return Array.from(emails);
}

// --- CORE WORKER LOGIC ---

async function processRow(row: any) {
    stats.active++;
    const start = Date.now();

    try {
        await sleep(API_CALL_DELAY);

        // Extract domain from URL
        const domain = row.url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        const query = `${domain} emails (site:${domain})`;
        const apiUrl = `https://google-search116.p.rapidapi.com/?query=${encodeURIComponent(query)}`;

        const response = await axios.get(apiUrl, {
            headers: {
                'x-rapidapi-key': RAPIDAPI_KEY,
                'x-rapidapi-host': RAPIDAPI_HOST
            },
            timeout: EXTERNAL_API_TIMEOUT
        });

        const data = response.data;
        const emails = extractEmails(Array.isArray(data) ? data : [data]);

        // Store raw results as text array (stringify each result object)
        const results = Array.isArray(data.results)
            ? data.results.map((r: any) => JSON.stringify(r))
            : [];

        // Update DB
        const { error } = await supabase
            .from('email_scraper_node')
            .update({
                status: 'completed',
                emails: emails,
                scrape_type: 'google_search',
                updated_at: new Date().toISOString()
            })
            .eq('id', row.id);

        if (error) throw error;
        stats.processed++;

    } catch (err: any) {
        stats.errors++;
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

        await supabase
            .from('email_scraper_node')
            .update({
                status: 'gs_error',
                message: errorMessage,
                scrape_type: 'google_search',
                updated_at: new Date().toISOString()
            })
            .eq('id', row.id);

    } finally {
        stats.active--;
        const duration = Date.now() - start;
        console.log(`[Worker] Job ${row.id} finished in ${duration}ms (Active: ${stats.active})`);
    }
}

async function fetchAndClaim(slots: number): Promise<any[]> {
    if (slots <= 0) return [];

    const { data, error } = await supabase
        .from('email_scraper_node')
        .select('*')
        .eq('status', 'need_google_search')
        .limit(slots);

    if (error) {
        console.error('Error fetching rows:', error);
        return [];
    }

    if (data && data.length > 0) {
        const ids = data.map(r => r.id);
        await supabase
            .from('email_scraper_node')
            .update({ status: 'gs_processing', scrape_type: 'google_search', updated_at: new Date().toISOString() })
            .in('id', ids);
    }

    return data || [];
}

async function mainLoop() {
    let backoffMs = 1000;
    const maxBackoff = 60000;

    console.log(`Starting worker with max concurrency: ${MAX_CONCURRENCY} (rate limit: 6 req/sec)`);

    const { count: queuedCount, error: qErr } = await supabase
        .from('email_scraper_node')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'need_google_search');

    if (qErr) {
        console.error("Startup check failed.", qErr);
    } else {
        console.log(`Startup Status: need_google_search=${queuedCount}`);
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
                        // Try to re-queue error jobs
                        const { data: errorJobs, error: errErr } = await supabase
                            .from('email_scraper_node')
                            .select('id')
                            .eq('status', 'gs_error')
                            .limit(slotsAvailable);

                        if (!errErr && errorJobs && errorJobs.length > 0) {
                            const ids = errorJobs.map(r => r.id);
                            await supabase
                                .from('email_scraper_node')
                                .update({ status: 'need_google_search', updated_at: new Date().toISOString() })
                                .in('id', ids);
                            console.log(`♻️ Re-queued ${errorJobs.length} gs_error jobs for retry.`);
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
