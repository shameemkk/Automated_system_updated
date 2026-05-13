import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

interface Target {
    url: string;
    activeCount: number;
    failureCount: number;
    cooldownUntil: number;
    totalRequests: number;
}

const URLS = (process.env.HTMLPARSER_URLS || process.env.HTMLPARSER_URL || 'http://localhost:3000')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

if (URLS.length === 0) {
    console.error('No htmlparser URL configured. Set HTMLPARSER_URLS or HTMLPARSER_URL.');
    process.exit(1);
}

const targets: Target[] = URLS.map(url => ({
    url,
    activeCount: 0,
    failureCount: 0,
    cooldownUntil: 0,
    totalRequests: 0,
}));

const HTMLPARSER_TIMEOUT_MS = parseInt(process.env.HTMLPARSER_TIMEOUT_MS || '150000', 10);
const COOLDOWN_MS = parseInt(process.env.HTMLPARSER_COOLDOWN_MS || '30000', 10);
const COOLDOWN_AFTER_FAILURES = parseInt(process.env.HTMLPARSER_COOLDOWN_AFTER || '3', 10);

console.log(`[scraper] configured ${targets.length} target(s): ${URLS.join(', ')}`);

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

export interface ScrapeResult {
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

export async function scrapeWebsite(url: string): Promise<ScrapeResult> {
    const target = pickTarget();
    if (!target) {
        const now = Date.now();
        const nextAt = Math.min(...targets.map(t => t.cooldownUntil));
        throw new Error(`htmlparser: all ${targets.length} target(s) in cooldown for ${Math.max(0, nextAt - now)}ms more`);
    }
    target.activeCount++;
    target.totalRequests++;

    const controller = new AbortController();
    const killSwitch = setTimeout(
        () => controller.abort(),
        HTMLPARSER_TIMEOUT_MS + 5_000
    );

    try {
        const response = await axios.post<ScrapeResult>(
            `${target.url}/extract-emails`,
            { url },
            {
                timeout: HTMLPARSER_TIMEOUT_MS,
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                validateStatus: status => status >= 200 && status < 300,
            }
        );
        target.failureCount = 0;
        target.cooldownUntil = 0;
        return response.data;
    } catch (err: any) {
        target.failureCount++;
        if (target.failureCount >= COOLDOWN_AFTER_FAILURES && target.cooldownUntil <= Date.now()) {
            target.cooldownUntil = Date.now() + COOLDOWN_MS;
            console.warn(`[scraper] ${target.url} cooled down for ${COOLDOWN_MS}ms after ${target.failureCount} consecutive failures`);
        }
        if (controller.signal.aborted) {
            throw new Error(`htmlparser hard-timeout after ${HTMLPARSER_TIMEOUT_MS + 5000}ms (target=${target.url})`);
        }
        if (axios.isAxiosError(err)) {
            const status = err.response?.status;
            const apiMsg = err.response?.data?.message || err.response?.data?.error;
            const detail = status ? `HTTP ${status}` : (err.code || 'network error');
            throw new Error(`htmlparser ${detail}${apiMsg ? `: ${apiMsg}` : `: ${err.message}`} (target=${target.url})`);
        }
        throw err;
    } finally {
        clearTimeout(killSwitch);
        target.activeCount--;
    }
}

export function getTargetStats() {
    const now = Date.now();
    return targets.map(t => ({
        url: t.url,
        active: t.activeCount,
        failures: t.failureCount,
        cooldownRemainingMs: Math.max(0, t.cooldownUntil - now),
        totalRequests: t.totalRequests,
    }));
}
