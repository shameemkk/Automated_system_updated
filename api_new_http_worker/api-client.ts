import axios, { AxiosError, AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import { config } from './config.js';

export interface ScrapeResponse {
    success: boolean;
    emails?: string[];
    facebook_urls?: string[];
    crawled_urls?: string[];
    pages_crawled?: number;
    js_rendered?: boolean;
    partial?: boolean;
    reason?: string;
    error?: string;
    message?: string;
}

export type ApiErrorKind =
    | 'bad_input'
    | 'rate_limited'
    | 'server_error'
    | 'timeout'
    | 'network'
    | 'all_cooled_down';

export class ApiClientError extends Error {
    constructor(
        public readonly kind: ApiErrorKind,
        message: string,
        public readonly status?: number,
        public readonly target?: string,
    ) {
        super(message);
        this.name = 'ApiClientError';
    }
}

interface Target {
    url: string;
    client: AxiosInstance;
    activeCount: number;
    failureCount: number;
    cooldownUntil: number;
    totalRequests: number;
    totalFailures: number;
}

function makeAxios(baseURL: string): AxiosInstance {
    const isHttps = baseURL.startsWith('https://');
    const Agent = isHttps ? https.Agent : http.Agent;
    const agent = new Agent({ keepAlive: true, maxSockets: config.MAX_CONCURRENCY });
    return axios.create({
        baseURL,
        timeout: config.REQUEST_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true, // we map ourselves
        httpAgent: isHttps ? undefined : agent,
        httpsAgent: isHttps ? agent : undefined,
    });
}

const targets: Target[] = config.HTTP_API_URLS.map(url => ({
    url,
    client: makeAxios(url),
    activeCount: 0,
    failureCount: 0,
    cooldownUntil: 0,
    totalRequests: 0,
    totalFailures: 0,
}));

console.log(`[api-client] configured ${targets.length} target(s): ${config.HTTP_API_URLS.join(', ')}`);

function pickTarget(): Target | null {
    const now = Date.now();
    const healthy = targets.filter(t => t.cooldownUntil <= now);
    if (healthy.length === 0) return null;
    return healthy.reduce((best, t) =>
        t.activeCount < best.activeCount ||
        (t.activeCount === best.activeCount && t.failureCount < best.failureCount)
            ? t
            : best
    );
}

function nextAvailableAt(): number {
    return Math.min(...targets.map(t => t.cooldownUntil));
}

function recordSuccess(target: Target): void {
    target.failureCount = 0;
    target.cooldownUntil = 0;
}

function recordFailure(target: Target): void {
    target.failureCount++;
    target.totalFailures++;
    if (
        target.failureCount >= config.COOLDOWN_AFTER &&
        target.cooldownUntil <= Date.now()
    ) {
        target.cooldownUntil = Date.now() + config.COOLDOWN_MS;
        console.warn(`[api-client] ${target.url} cooled down for ${config.COOLDOWN_MS}ms after ${target.failureCount} consecutive failures`);
    }
}

function classifyAxiosError(err: AxiosError, target: string): ApiClientError {
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        return new ApiClientError('timeout', `request timed out after ${config.REQUEST_TIMEOUT_MS}ms`, undefined, target);
    }
    if (err.code === 'ECONNRESET' || err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'EAI_AGAIN') {
        return new ApiClientError('network', `${err.code}: ${err.message}`, undefined, target);
    }
    return new ApiClientError('network', err.message || 'network error', undefined, target);
}

function classifyResponseStatus(status: number, body: ScrapeResponse, target: string): ApiClientError | null {
    if (status >= 200 && status < 300) return null;
    const msg = body?.message || body?.error || `HTTP ${status}`;
    if (status === 400) return new ApiClientError('bad_input', msg, status, target);
    if (status === 429) return new ApiClientError('rate_limited', msg, status, target);
    if (status >= 500) return new ApiClientError('server_error', msg, status, target);
    return new ApiClientError('server_error', `unexpected status ${status}: ${msg}`, status, target);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function backoffFor(kind: ApiErrorKind, attempt: number): number {
    const base =
        kind === 'rate_limited'
            ? config.API_RATE_LIMIT_BACKOFF_BASE_MS
            : config.API_RETRY_BACKOFF_BASE_MS;
    // exponential with jitter
    const exp = base * 2 ** (attempt - 1);
    const jitter = Math.floor(Math.random() * (base / 2));
    return Math.min(exp + jitter, 30_000);
}

function shouldRetry(kind: ApiErrorKind, attempt: number, max: number): boolean {
    if (kind === 'bad_input' || kind === 'all_cooled_down') return false;
    if (kind === 'timeout' && attempt >= 2) return false; // timeouts get one retry only
    return attempt < max;
}

function parseRetryAfter(header: unknown): number | null {
    if (typeof header !== 'string') return null;
    const seconds = parseInt(header, 10);
    if (!Number.isNaN(seconds)) return seconds * 1_000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    return null;
}

async function callOnce(target: Target, url: string): Promise<ScrapeResponse> {
    target.activeCount++;
    target.totalRequests++;

    const controller = new AbortController();
    const killSwitch = setTimeout(
        () => controller.abort(),
        config.REQUEST_TIMEOUT_MS + 5_000
    );

    try {
        const response = await target.client.post<ScrapeResponse>(
            '/extract-emails',
            { url },
            { signal: controller.signal }
        );

        const status = response.status;
        const body = response.data ?? ({} as ScrapeResponse);

        const errorFromStatus = classifyResponseStatus(status, body, target.url);
        if (errorFromStatus) {
            // attach Retry-After for rate-limited responses
            if (errorFromStatus.kind === 'rate_limited') {
                const retryMs = parseRetryAfter(response.headers?.['retry-after']);
                if (retryMs !== null) (errorFromStatus as ApiClientError & { retryAfterMs?: number }).retryAfterMs = retryMs;
            }
            recordFailure(target);
            throw errorFromStatus;
        }

        recordSuccess(target);
        return body;
    } catch (err) {
        if (err instanceof ApiClientError) throw err;

        if (controller.signal.aborted) {
            recordFailure(target);
            throw new ApiClientError('timeout', `hard-abort after ${config.REQUEST_TIMEOUT_MS + 5_000}ms`, undefined, target.url);
        }

        if (axios.isAxiosError(err)) {
            recordFailure(target);
            throw classifyAxiosError(err, target.url);
        }

        recordFailure(target);
        throw new ApiClientError('network', (err as Error)?.message || 'unknown error', undefined, target.url);
    } finally {
        clearTimeout(killSwitch);
        target.activeCount--;
    }
}

export async function callExtractEmails(url: string): Promise<ScrapeResponse> {
    let lastError: ApiClientError | null = null;

    for (let attempt = 1; attempt <= config.API_MAX_RETRIES + 1; attempt++) {
        const target = pickTarget();
        if (!target) {
            const waitMs = Math.max(0, nextAvailableAt() - Date.now());
            throw new ApiClientError(
                'all_cooled_down',
                `all ${targets.length} target(s) in cooldown; next available in ${waitMs}ms`
            );
        }

        try {
            return await callOnce(target, url);
        } catch (err) {
            if (!(err instanceof ApiClientError)) throw err;
            lastError = err;

            if (!shouldRetry(err.kind, attempt, config.API_MAX_RETRIES + 1)) break;

            const extra = err as ApiClientError & { retryAfterMs?: number };
            const delay = extra.retryAfterMs ?? backoffFor(err.kind, attempt);
            if (config.DEBUG) {
                console.warn(`[api-client] attempt ${attempt} failed (${err.kind}); retrying in ${delay}ms: ${err.message}`);
            }
            await sleep(delay);
        }
    }

    throw lastError ?? new ApiClientError('network', 'unknown failure');
}

export interface TargetStats {
    url: string;
    active: number;
    failures: number;
    cooldownRemainingMs: number;
    totalRequests: number;
    totalFailures: number;
}

export function getTargetStats(): TargetStats[] {
    const now = Date.now();
    return targets.map(t => ({
        url: t.url,
        active: t.activeCount,
        failures: t.failureCount,
        cooldownRemainingMs: Math.max(0, t.cooldownUntil - now),
        totalRequests: t.totalRequests,
        totalFailures: t.totalFailures,
    }));
}

export async function checkAllTargets(): Promise<{ url: string; ok: boolean; detail: string }[]> {
    return Promise.all(
        targets.map(async (t) => {
            try {
                const res = await t.client.get('/health', { timeout: 5_000 });
                if (res.status === 200) return { url: t.url, ok: true, detail: `HTTP 200` };
                return { url: t.url, ok: false, detail: `HTTP ${res.status}` };
            } catch (err) {
                const msg = (err as Error)?.message || 'unknown';
                return { url: t.url, ok: false, detail: msg };
            }
        })
    );
}
