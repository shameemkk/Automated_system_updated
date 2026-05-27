import * as dotenv from 'dotenv';

dotenv.config();

function parseIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) {
        throw new Error(`Invalid integer for ${name}: "${raw}"`);
    }
    return n;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    return raw.toLowerCase() === 'true' || raw === '1';
}

function parseUrlList(): string[] {
    const list = process.env.HTTP_API_URLS || process.env.HTTP_API_URL || '';
    const urls = list
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    for (const u of urls) {
        try {
            const parsed = new URL(u);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                throw new Error(`HTTP_API_URLS contains non-http(s) URL: ${u}`);
            }
        } catch (err) {
            throw new Error(`HTTP_API_URLS contains invalid URL "${u}": ${(err as Error).message}`);
        }
    }
    return urls;
}

const REQUEST_TIMEOUT_MS = parseIntEnv('REQUEST_TIMEOUT_MS', 130_000);
if (REQUEST_TIMEOUT_MS < 30_000) {
    throw new Error(`REQUEST_TIMEOUT_MS must be >= 30000 (got ${REQUEST_TIMEOUT_MS}). The API's OVERALL_TIMEOUT_MS defaults to 120s; values below 30s risk aborting valid scrapes.`);
}
if (REQUEST_TIMEOUT_MS < 125_000) {
    console.warn(`[config] WARNING: REQUEST_TIMEOUT_MS=${REQUEST_TIMEOUT_MS} is below the API's default OVERALL_TIMEOUT_MS=120000. The worker may abort before the API can return a legitimate { partial: true } response.`);
}

if (!process.env.DATABASE_URL) {
    throw new Error('Missing required env DATABASE_URL.');
}

const HTTP_API_URLS = parseUrlList();
if (HTTP_API_URLS.length === 0) {
    throw new Error('No HTTP API URL configured. Set HTTP_API_URLS (comma-separated) or HTTP_API_URL.');
}

const MAX_CONCURRENCY = parseIntEnv('MAX_CONCURRENCY', 150);
const RESUME_THRESHOLD = parseIntEnv('RESUME_THRESHOLD', 1000);
const MAX_PENDING_UPDATES = parseIntEnv('MAX_PENDING_UPDATES', 2000);

if (RESUME_THRESHOLD >= MAX_PENDING_UPDATES) {
    throw new Error(`RESUME_THRESHOLD (${RESUME_THRESHOLD}) must be < MAX_PENDING_UPDATES (${MAX_PENDING_UPDATES}).`);
}

export const config = Object.freeze({
    DATABASE_URL: process.env.DATABASE_URL,
    PG_POOL_MAX: parseIntEnv('PG_POOL_MAX', 20),
    PG_SSL: parseBoolEnv('PG_SSL', true),

    HTTP_API_URLS,
    API_HEALTH_CHECK_AT_STARTUP: parseBoolEnv('API_HEALTH_CHECK_AT_STARTUP', true),

    REQUEST_TIMEOUT_MS,

    COOLDOWN_AFTER: parseIntEnv('COOLDOWN_AFTER', 3),
    COOLDOWN_MS: parseIntEnv('COOLDOWN_MS', 30_000),

    API_MAX_RETRIES: parseIntEnv('API_MAX_RETRIES', 2),
    API_RETRY_BACKOFF_BASE_MS: parseIntEnv('API_RETRY_BACKOFF_BASE_MS', 500),
    API_RATE_LIMIT_BACKOFF_BASE_MS: parseIntEnv('API_RATE_LIMIT_BACKOFF_BASE_MS', 5_000),

    MAX_CONCURRENCY,
    CLAIM_BATCH_MAX: parseIntEnv('CLAIM_BATCH_MAX', 50),
    MAX_PENDING_UPDATES,
    RESUME_THRESHOLD,

    BATCH_FLUSH_SIZE: parseIntEnv('BATCH_FLUSH_SIZE', 50),
    BATCH_FLUSH_INTERVAL_MS: parseIntEnv('BATCH_FLUSH_INTERVAL_MS', 5_000),
    BATCH_MAX_FLUSH_RETRIES: parseIntEnv('BATCH_MAX_FLUSH_RETRIES', 3),

    SHUTDOWN_GRACE_MS: parseIntEnv('SHUTDOWN_GRACE_MS', 30_000),

    WATCHDOG_LOCK_KEY: parseIntEnv('WATCHDOG_LOCK_KEY', 8_472_345),
    STUCK_AFTER_MINUTES: parseIntEnv('STUCK_AFTER_MINUTES', 10),
    WATCHDOG_INTERVAL_MS: parseIntEnv('WATCHDOG_INTERVAL_MS', 60_000),
    DIAG_INTERVAL_MS: parseIntEnv('DIAG_INTERVAL_MS', 300_000),
    WATCHDOG_REACQUIRE_MS: parseIntEnv('WATCHDOG_REACQUIRE_MS', 30_000),
    STALE_AGE_WARN_SECONDS: parseIntEnv('STALE_AGE_WARN_SECONDS', 3_600),

    STATS_LOG_INTERVAL_MS: parseIntEnv('STATS_LOG_INTERVAL_MS', 30_000),
    DEBUG: parseBoolEnv('DEBUG', false),
});

export type Config = typeof config;

console.log(`[config] loaded — concurrency=${config.MAX_CONCURRENCY}, targets=${config.HTTP_API_URLS.length}, request-timeout=${config.REQUEST_TIMEOUT_MS}ms`);
