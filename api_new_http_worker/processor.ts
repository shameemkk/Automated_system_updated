import { callExtractEmails, ApiClientError, type ScrapeResponse } from './api-client.js';
import type { Batcher } from './batcher.js';
import type { ScraperRow, PendingUpdate } from './db.js';

export interface Stats {
    processed: number;
    errors: number;
    escalated: number;
    active: number;
}

function safeArray(x: unknown): string[] {
    if (!Array.isArray(x)) return [];
    return x.filter((v): v is string => typeof v === 'string');
}

function decideOnSuccess(row: ScraperRow, body: ScrapeResponse): PendingUpdate {
    const emails = safeArray(body.emails);
    const facebook_urls = safeArray(body.facebook_urls);
    const hasEmails = emails.length > 0;
    const hasFacebook = facebook_urls.length > 0;
    const needsBrowser = body.js_rendered === false;
    const partial = body.partial === true;

    let status: string;
    let needs_browser_rendering = false;

    if (hasEmails) {
        status = 'auto_completed';
    } else if (hasFacebook) {
        status = 'auto_need_google_search';
    } else if (needsBrowser) {
        status = 'auto_need_browser_rendering';
        needs_browser_rendering = true;
    } else if (partial) {
        // partial timeout with no data → site was slow / heavy; punt to browser
        status = emails.length >= 4 ? 'auto_completed' : 'auto_need_browser_rendering';
        if (status === 'auto_need_browser_rendering') needs_browser_rendering = true;
    } else {
        // completed cleanly but found nothing — try google search fallback
        status = 'auto_need_google_search';
    }

    return {
        id: row.id,
        status,
        emails,
        facebook_urls,
        message: null,
        needs_browser_rendering,
    };
}

function decideOnError(row: ScraperRow, err: ApiClientError): PendingUpdate {
    const retriesExhausted = row.retry_count >= 1;

    if (err.kind === 'bad_input') {
        // 400 from API is deterministic — bad URL, unsupported extension, etc.
        return {
            id: row.id,
            status: 'auto_error',
            emails: [],
            facebook_urls: [],
            message: `bad_input: ${err.message}`,
            needs_browser_rendering: false,
        };
    }

    // Transient errors: timeout, network, server_error, rate_limited, all_cooled_down.
    // First failure → auto_error (DB retry RPC re-queues it once).
    // After that → escalate to browser rendering (this URL is too slow/blocked for HTTP).
    const escalate = retriesExhausted;
    return {
        id: row.id,
        status: escalate ? 'auto_need_browser_rendering' : 'auto_error',
        emails: [],
        facebook_urls: [],
        message: `${err.kind}: ${err.message}`,
        needs_browser_rendering: escalate,
    };
}

export async function processRow(
    row: ScraperRow,
    batcher: Batcher,
    stats: Stats
): Promise<void> {
    stats.active++;
    const start = Date.now();

    try {
        const body = await callExtractEmails(row.url);

        // API can return 200 with success: false (e.g., 500 path that returned a body).
        // Treat that as a server_error-shaped failure.
        if (body.success === false) {
            const msg = body.message || body.error || 'unknown api failure';
            const synthetic = new ApiClientError('server_error', msg);
            const update = decideOnError(row, synthetic);
            batcher.push(update);
            if (update.status === 'auto_need_browser_rendering') stats.escalated++;
            stats.errors++;
            return;
        }

        const update = decideOnSuccess(row, body);
        batcher.push(update);
        stats.processed++;
    } catch (err) {
        if (err instanceof ApiClientError) {
            const update = decideOnError(row, err);
            batcher.push(update);
            if (update.status === 'auto_need_browser_rendering') stats.escalated++;
            stats.errors++;
            return;
        }

        // Truly unexpected — log loudly, but still write an error row so the
        // job doesn't sit in auto_processing forever.
        const msg = (err as Error)?.message || String(err);
        console.error(`[processor] unexpected error processing row ${row.id}:`, err);
        batcher.push({
            id: row.id,
            status: row.retry_count >= 1 ? 'auto_need_browser_rendering' : 'auto_error',
            emails: [],
            facebook_urls: [],
            message: `unexpected: ${msg}`,
            needs_browser_rendering: row.retry_count >= 1,
        });
        stats.errors++;
    } finally {
        stats.active--;
        const duration = Date.now() - start;
        if (duration > 5_000) {
            console.log(`[processor] row ${row.id} took ${duration}ms (active=${stats.active}, pending=${batcher.size()})`);
        }
    }
}
