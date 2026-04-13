
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import PQueue from 'p-queue';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '100', 10);
const EXTERNAL_API_URL = process.env.EXTERNAL_API_URL || '';
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '';
const EXTERNAL_API_TIMEOUT = 120000;
const API_CALL_DELAY = parseInt(process.env.API_CALL_DELAY || '250', 10);
const DEBUG = process.env.DEBUG === 'false';
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

// Cache for per-client filters (zip codes + allowed types) - fetched once at startup.
// Each field's `null` value = "accept all" sentinel (client has no filter configured for that field).
// Absent map key = client_tag not yet loaded, needs refresh.
type ClientFilter = {
    zips: Set<string> | null;   // null = no zip filter -> accept all
    types: Set<string> | null;  // null = no type filter -> accept all (lowercased entries)
};
const clientFiltersCache = new Map<string, ClientFilter>();

// Mutex to prevent concurrent cache refreshes
let isRefreshing = false;
const refreshWaiters: Array<() => void> = [];

// Concurrency Queue
const queue = new PQueue({ concurrency: MAX_CONCURRENCY });

let shuttingDown = false;

// --- UTILITIES ---

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetch all client_details and populate the filter cache (zips + allowed types).
 * Called at startup and when new client_tags are encountered.
 * Protected by mutex to prevent concurrent refreshes.
 */
async function loadClientFilters() {
    console.log('Loading client filters (zips + types) from client_details...');
    const { data, error } = await supabase
        .from('client_details')
        .select('client_tag, zip_codes_format, allowed_types');

    if (error) {
        console.error('Error loading client_details:', error);
        return;
    }

    if (!data || data.length === 0) {
        console.warn('No client_details found. All results will be filtered out.');
        return;
    }

    // Clear existing cache and reload all
    clientFiltersCache.clear();

    for (const row of data) {
        const zipsRaw = row.zip_codes_format;
        const typesRaw = row.allowed_types;

        const zips: Set<string> | null =
            !zipsRaw || zipsRaw.length === 0 ? null : new Set<string>(zipsRaw);

        // Pre-lowercase allowed types so the hot-path comparison is a cheap Set.has().
        const types: Set<string> | null =
            !typesRaw || typesRaw.length === 0
                ? null
                : new Set<string>(typesRaw.map((t: string) => String(t).toLowerCase()));

        clientFiltersCache.set(row.client_tag, { zips, types });
    }

    console.log(`Loaded filters for ${clientFiltersCache.size} client tags.`);
}

/**
 * Thread-safe cache refresh with mutex protection
 * Ensures only one refresh happens at a time, others wait
 */
async function safeRefreshCache(): Promise<void> {
    // If already refreshing, wait for it to complete
    if (isRefreshing) {
        console.log('Cache refresh already in progress, waiting...');
        return new Promise<void>((resolve) => {
            refreshWaiters.push(resolve);
        });
    }

    // Acquire lock
    isRefreshing = true;
    
    try {
        await loadClientFilters();
    } finally {
        // Release lock and notify all waiters
        isRefreshing = false;
        const waiters = refreshWaiters.splice(0);
        waiters.forEach(resolve => resolve());
    }
}

/**
 * Resolve a client_tag's filter struct, refreshing the cache once if missing.
 * Returns null if the tag still cannot be found after a refresh — callers should
 * treat that as "drop everything for this client" (same behavior as before).
 *
 * Use .has() so a cached `{ zips: null, types: null }` accept-all entry is NOT
 * mistaken for "missing".
 */
async function getClientFilter(clientTag: string): Promise<ClientFilter | null> {
    if (!clientFiltersCache.has(clientTag)) {
        console.log(`Client tag '${clientTag}' not found in cache. Refreshing all client_tags...`);
        await safeRefreshCache();

        if (!clientFiltersCache.has(clientTag)) {
            console.warn(`Client tag '${clientTag}' not found in client_details after refresh.`);
            return null;
        }
    }

    // Safe cast: .has() confirmed the key exists.
    return clientFiltersCache.get(clientTag) as ClientFilter;
}

/**
 * Check if full_address contains any of the client's allowed zip-code substrings.
 * `null` zips = accept-all sentinel.
 */
function matchesZip(filter: ClientFilter, fullAddress: string | null): boolean {
    if (filter.zips === null) return true;

    const fullAddressLowercase = (fullAddress?.toLowerCase() || "");
    if (!fullAddressLowercase) return false;

    for (const k of filter.zips) {
        if (fullAddressLowercase.includes(String(k).toLowerCase())) return true;
    }
    return false;
}

/**
 * Check if any element of the API result's `types` array is in the client's
 * allowed-types set (case-insensitive). `null` types = accept-all sentinel.
 * If the API result has no types array we cannot prove a match → reject.
 */
function matchesTypes(filter: ClientFilter, types: string[] | null | undefined): boolean {
    if (filter.types === null) return true;
    if (!types || types.length === 0) return false;

    for (const t of types) {
        if (filter.types.has(String(t).toLowerCase())) return true;
    }
    return false;
}

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
 * Fetch auto_queued and auto_error client_queries and mark as auto_processing
 * Prioritizes auto_queued over auto_error
 */
async function fetchAutoClientQueries(batchSize: number): Promise<any[]> {
    if (batchSize <= 0) return [];

    const { data, error } = await supabase
        .rpc('fetch_auto_queries', { p_batch_size: batchSize });

    if (error) {
        console.error('Error fetching auto client_queries via RPC:', error);
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

        const MAX_ATTEMPTS = 3; // 1 initial + 2 retries on empty results
        let apiResponse: any;
        let businesses: any[] = [];

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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

            apiResponse = response.data;
            if (DEBUG) {
                console.log(apiResponse)
            }

            // Non-ok status is a hard failure — break and let the existing throw below handle it.
            if (apiResponse?.status !== 'ok') break;

            businesses = apiResponse.data || [];
            if (businesses.length > 0) break;

            // Empty result — retry if we still have attempts left.
            if (attempt < MAX_ATTEMPTS) {
                console.log(`[Worker] ClientQuery ${row.id} returned 0 results (attempt ${attempt}/${MAX_ATTEMPTS}). Retrying in 500ms...`);
                await sleep(500);
            }
        }

        // Check if API returned success
        if (apiResponse?.status === 'ok') {

            // Insert results into client_query_results
            if (businesses.length > 0) {
                const allResults = businesses.map((biz: any) => ({
                    client_query_id: row.id,
                    client_tag: row.client_tag,
                    automation_id: row.automation_id,
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
                    rating: biz.rating,
                    mode: 'auto',
                    processed: true,
                }));

                // Filter results: keep only rows that have a website AND pass both
                // the client's zip-code filter and allowed-types filter.
                // Resolve the client filter once for the whole batch — same client_tag
                // for every row in `allResults`, no need to re-look it up per row.
                const filter = await getClientFilter(row.client_tag);
                const results: any[] = [];
                if (filter !== null) {
                    for (const r of allResults) {
                        if (r.website === null) continue;
                        if (!matchesZip(filter, r.full_address)) continue;
                        if (!matchesTypes(filter, r.types)) continue;
                        results.push(r);
                    }
                }

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
                    status: 'auto_completed',
                    api_status: 'auto_ok',
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
                status: 'auto_error',
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

    // Load client filters (zips + allowed types) once at startup
    await loadClientFilters();

    // Startup Check
    const { count: queuedCount, error: qErr } = await supabase
        .from('client_queries')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'auto_queued');

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
                const jobs = await fetchAutoClientQueries(slotsAvailable);

                if (jobs.length > 0) {
                    backoffMs = 1000;
                    console.log(`Claimed ${jobs.length} jobs (auto_queued/auto_error).`);
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