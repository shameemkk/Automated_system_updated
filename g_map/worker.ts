
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import PQueue from 'p-queue';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '300', 10);
const EXTERNAL_API_URL = process.env.EXTERNAL_API_URL || '';
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '';
const EXTERNAL_API_TIMEOUT = 120000;
const API_CALL_DELAY = parseInt(process.env.API_CALL_DELAY || '250', 10);
const DEBUG = process.env.DEBUG || false;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
    process.exit(1);
}
if (!EXTERNAL_API_URL) {
    console.error('Missing EXTERNAL_API_URL in .env');
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

/**
 * Extract zip/postal code from full_address_array using regex
 * Supports: US (12345, 12345-6789), UK (SW1A 1AA), Canada (A1A 1A1), etc.
 */
function extractZipCode(addressArray: string[] | null): string | null {
    if (!addressArray || !Array.isArray(addressArray)) return null;
    
    const zipPatterns = [
        /\b\d{5}(-\d{4})?\b/,                    // US: 12345 or 12345-6789
        /\b[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}\b/i,  // UK: SW1A 1AA, E1 6AN
        /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i,         // Canada: A1A 1A1
                          
    ];
    
    for (const part of addressArray) {
        for (const pattern of zipPatterns) {
            const match = part.match(pattern);
            if (match) return match[0];
        }
    }
    return null;
}

// --- CORE WORKER LOGIC ---

/**
 * Fetch queued client_queries and mark as processing
 * Groups by client_tag - processes all items from one tag before moving to next
 */
async function fetchClientQueries(batchSize: number): Promise<any[]> {
    if (batchSize <= 0) return [];

    const { data, error } = await supabase
        .rpc('fetch_queries', { p_batch_size: batchSize });

    if (error) {
        console.error('Error fetching client_queries via RPC:', error);
        return [];
    }

    return data || [];
}

/**
 * Process a client_query row - call API and insert results
 */
async function processClientQuery(row: any) {
    stats.active++;
    const start = Date.now();

    try {
        // API_CALL_DELAY removed - p-queue already handles concurrency
        // Uncomment below if rate limiting is needed:
        // await sleep(API_CALL_DELAY);

        const response = await axios.get(EXTERNAL_API_URL, {
            params: {
                query: row.query,
                lat: row.latitude,
                lng: row.longitude,
                country: row.region,
                lang: 'en',
                limit: 0,
                offset: 0,
                zoom: 12
            },
            headers: {
                'scraper-key': SCRAPER_API_KEY
            },
            timeout: EXTERNAL_API_TIMEOUT
        });
       
        const apiResponse = response.data;
        if (DEBUG) console.log(apiResponse)
        



        
        // Check if API returned success
        if (apiResponse?.status === 'ok') {
            const businesses = apiResponse.data || [];

            // Insert results into client_query_results
            if (businesses.length > 0) {
                const results = businesses.map((biz: any) => ({
                    client_query_id: row.id,
                    client_tag: row.client_tag,
                    name: biz.name,
                    website: biz.website,
                    types: biz.types,
                    zip_code: extractZipCode(biz.full_address_array),
                    phone_number: biz.phone_number,
                    full_address: biz.full_address,
                    city: biz.city,
                    place_link: biz.place_link,
                    timezone: biz.timezone,
                    review_count: biz.review_count,
                    rating: biz.rating
                })).filter((r: any) => r.zip_code !== null && r.website !== null);

                if (results.length > 0) {
                    // Batch check: get all websites that already exist in "google map scraped data v1"
                    const websites = results.map((r: any) => r.website);
                    const { data: existingData } = await supabase
                        .from('google map scraped data v1')
                        .select('website')
                        .in('website', websites);

                    const existingWebsites = new Set((existingData || []).map((d: any) => d.website));
                    // if (DEBUG) console.log(websites);
                    // Filter out results that already exist
                    const newResults = results.filter((r: any) => !existingWebsites.has(r.website));

                    // Insert one by one to handle unique constraint violations on website
                    for (const result of newResults) {
                        const { error: insertError } = await supabase
                            .from('client_query_results')
                            .insert(result);

                        // Ignore unique constraint violation (code 23505), throw other errors
                        if (insertError && insertError.code !== '23505') {
                            throw insertError;
                        }
                        console.log("insertError:", insertError);
                    }
                }
            }

            // Update client_query status
            const { error: updateError } = await supabase
                .from('client_queries')
                .update({
                    status: 'completed',
                    api_status: 'ok',
                    length: businesses.length
                })
                .eq('id', row.id);

            if (updateError) throw updateError;
            stats.processed++;
        } else {
            throw new Error('Invalid API response format');
        }

    } catch (err: any) {
        stats.errors++;
        let errorMessage = 'Unknown fatal error';
        if (axios.isAxiosError(err)) {
            errorMessage = err.message;
            if (err.code === 'ECONNABORTED') errorMessage = 'Timeout';
            if (err.response) {
                const apiError = err.response.data?.error?.message || err.response.data?.message || JSON.stringify(err.response.data);
                errorMessage = `API Error ${err.response.status}: ${apiError}`;
            }
        } else if (err instanceof Error) {
            errorMessage = err.message;
        }

        await supabase
            .from('client_queries')
            .update({
                status: 'error',
                api_status: errorMessage
            })
            .eq('id', row.id);

    } finally {
        stats.active--;
        const duration = Date.now() - start;
        console.log(`[Worker] ClientQuery ${row.id} finished in ${duration}ms (Active: ${stats.active})`);
    }
}

async function mainLoop() {
    let backoffMs = 1000;
    const maxBackoff = 60000;

    console.log(`Starting Supabase worker with max concurrency: ${MAX_CONCURRENCY}`);

    // Startup Check
    const { count: queuedCount, error: qErr } = await supabase
        .from('client_queries')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'queued');

    if (qErr) {
        console.error("Startup check failed. Check credentials/connection.", qErr);
    } else {
        console.log(`Startup Status: Queued=${queuedCount}`);
    }

    while (!shuttingDown) {
        try {
            const currentPending = queue.pending;
            const slotsAvailable = MAX_CONCURRENCY - currentPending;

            if (slotsAvailable > 0) {
                const jobs = await fetchClientQueries(slotsAvailable);

                if (jobs.length > 0) {
                    backoffMs = 1000;
                    console.log(`Claimed ${jobs.length} jobs.`);
                    jobs.forEach(row => {
                        queue.add(() => processClientQuery(row));
                    });
                } else {
                    if (queue.size === 0 && queue.pending === 0) {
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