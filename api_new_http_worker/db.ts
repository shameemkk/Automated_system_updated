import pkg from 'pg';
import { config } from './config.js';

const { Pool, Client } = pkg;

export const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.PG_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: config.PG_SSL ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => console.error('[pg pool] idle client error:', err));

export interface ScraperRow {
    id: number;
    url: string;
    client_tag: string;
    status: string;
    scrape_type: string;
    retry_count: number;
}

export interface PendingUpdate {
    id: number;
    status: string;
    emails: string[];
    facebook_urls: string[];
    message: string | null;
    needs_browser_rendering: boolean;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', '57P01', '08006', '08003']);
const TRANSIENT_MSG_FRAGMENTS = [
    'Connection terminated',
    'connection reset',
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'Client has encountered a connection error',
];

function isTransient(err: unknown): boolean {
    const e = err as { message?: unknown; code?: unknown };
    const msg = String(e?.message ?? '');
    const code = String(e?.code ?? '');
    if (TRANSIENT_CODES.has(code)) return true;
    return TRANSIENT_MSG_FRAGMENTS.some(f => msg.includes(f));
}

export async function withRetry<T>(operation: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (err) {
            if (attempt === maxRetries || !isTransient(err)) throw err;
            const backoff = Math.min(1_000 * 2 ** (attempt - 1), 10_000);
            const msg = (err as Error)?.message ?? String(err);
            console.warn(`[db] transient error (attempt ${attempt}/${maxRetries}), retrying in ${backoff}ms: ${msg}`);
            await sleep(backoff);
        }
    }
    throw new Error('withRetry: unreachable');
}

export async function claimJobs(batchSize: number): Promise<ScraperRow[]> {
    if (batchSize <= 0) return [];
    const { rows } = await withRetry(() =>
        pool.query<ScraperRow>(
            'SELECT * FROM auto_get_next_email_scraper_nodes_http_request($1)',
            [batchSize]
        )
    );
    return rows;
}

export async function batchUpdate(updates: PendingUpdate[]): Promise<number> {
    if (updates.length === 0) return 0;
    const { rows } = await withRetry(() =>
        pool.query<{ affected: number }>(
            'SELECT auto_batch_update_email_scraper_nodes($1::jsonb) AS affected',
            [JSON.stringify(updates)]
        )
    );
    return rows[0]?.affected ?? 0;
}

export async function retryErrorJobs(): Promise<number> {
    const { rows } = await withRetry(() =>
        pool.query<{ retried: number }>(
            'SELECT auto_retry_error_jobs_http_request() AS retried'
        )
    );
    return rows[0]?.retried ?? 0;
}

export async function reclaimStuckJobs(staleMinutes: number): Promise<number> {
    const { rows } = await withRetry(() =>
        pool.query<{ reclaimed: number }>(
            'SELECT auto_reclaim_stuck_http_request($1::int) AS reclaimed',
            [staleMinutes]
        )
    );
    return rows[0]?.reclaimed ?? 0;
}

export async function countQueued(): Promise<number> {
    const { rows } = await withRetry(() =>
        pool.query<{ c: number }>(
            `SELECT COUNT(*)::int AS c FROM email_scraper_node
             WHERE status = 'auto_queued' AND scrape_type = 'http_request'`
        )
    );
    return rows[0].c;
}

/**
 * Long-lived client for session-scoped pg_try_advisory_lock — must NOT come
 * from the pool. Pooled connections recycle and would silently release the lock.
 */
export async function createDedicatedClient(): Promise<pkg.Client> {
    const client = new Client({
        connectionString: config.DATABASE_URL,
        connectionTimeoutMillis: 5_000,
        ssl: config.PG_SSL ? { rejectUnauthorized: false } : false,
    });
    await client.connect();
    return client;
}

export interface QueueHealthRow {
    status: string;
    count: number;
    oldest_age_seconds: number;
}

export async function queueHealth(): Promise<QueueHealthRow[]> {
    const { rows } = await withRetry(() =>
        pool.query<QueueHealthRow>(
            `SELECT status,
                    COUNT(*)::int AS count,
                    EXTRACT(EPOCH FROM (NOW() - MIN(updated_at)))::int AS oldest_age_seconds
             FROM email_scraper_node
             WHERE scrape_type = 'http_request'
             GROUP BY status
             ORDER BY status`
        )
    );
    return rows;
}
