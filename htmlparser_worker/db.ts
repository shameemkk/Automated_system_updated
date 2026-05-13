import pkg from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const { Pool, Client } = pkg;

if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL in .env');
    process.exit(1);
}

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: parseInt(process.env.PG_POOL_MAX || '10', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
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

export async function withRetry<T>(operation: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error: any) {
            if (attempt === maxRetries) throw error;

            const msg = String(error?.message || '');
            const code = String(error?.code || '');
            const transient =
                msg.includes('Connection terminated') ||
                msg.includes('connection reset') ||
                msg.includes('ECONNRESET') ||
                msg.includes('ETIMEDOUT') ||
                msg.includes('ECONNREFUSED') ||
                code === 'ECONNRESET' ||
                code === 'ETIMEDOUT' ||
                code === '57P01' ||
                code === '08006' ||
                code === '08003';

            if (!transient) throw error;

            const backoff = Math.min(1000 * 2 ** (attempt - 1), 10_000);
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

export async function countQueued(scrapeType = 'http_request'): Promise<number> {
    const { rows } = await withRetry(() =>
        pool.query<{ c: number }>(
            `SELECT COUNT(*)::int AS c FROM email_scraper_node
             WHERE status = 'auto_queued' AND scrape_type = $1`,
            [scrapeType]
        )
    );
    return rows[0].c;
}

/**
 * Dedicated long-lived client used by the watchdog to hold a session-scoped
 * pg_try_advisory_lock. Must NOT come from the Pool — pooled connections get
 * recycled to other queries, which would silently release the lock.
 */
export async function createDedicatedClient(): Promise<pkg.Client> {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 5_000,
        ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
    });
    await client.connect();
    return client;
}

export async function queueHealth(scrapeType = 'http_request'): Promise<Array<{ status: string; count: number; oldest_age_seconds: number }>> {
    const { rows } = await withRetry(() =>
        pool.query<{ status: string; count: number; oldest_age_seconds: number }>(
            `SELECT status,
                    COUNT(*)::int AS count,
                    EXTRACT(EPOCH FROM (NOW() - MIN(updated_at)))::int AS oldest_age_seconds
             FROM email_scraper_node
             WHERE scrape_type = $1
             GROUP BY status
             ORDER BY status`,
            [scrapeType]
        )
    );
    return rows;
}
