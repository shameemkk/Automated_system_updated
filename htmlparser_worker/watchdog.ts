import {
    createDedicatedClient,
    queueHealth,
    reclaimStuckJobs,
} from './db.js';
import { getTargetStats } from './scraper.js';
import type pkg from 'pg';

const WATCHDOG_LOCK_KEY = parseInt(process.env.WATCHDOG_LOCK_KEY || '8472344', 10);
const STUCK_AFTER_MINUTES = parseInt(process.env.STUCK_AFTER_MINUTES || '10', 10);
const WATCHDOG_INTERVAL_MS = parseInt(process.env.WATCHDOG_INTERVAL_MS || '60000', 10);
const DIAG_INTERVAL_MS = parseInt(process.env.DIAG_INTERVAL_MS || '300000', 10);
const STALE_AGE_WARN_SECONDS = parseInt(process.env.STALE_AGE_WARN_SECONDS || '3600', 10);
const REACQUIRE_BACKOFF_MS = parseInt(process.env.WATCHDOG_REACQUIRE_MS || '30000', 10);

let leaderClient: pkg.Client | null = null;
let recoveryTimer: NodeJS.Timeout | null = null;
let diagTimer: NodeJS.Timeout | null = null;
let reacquireTimer: NodeJS.Timeout | null = null;
let stoppedExplicitly = false;

async function tryAcquireLeader(client: pkg.Client): Promise<boolean> {
    const { rows } = await client.query<{ got: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS got',
        [WATCHDOG_LOCK_KEY]
    );
    return rows[0]?.got === true;
}

async function releaseLeadership(): Promise<void> {
    if (recoveryTimer) {
        clearInterval(recoveryTimer);
        recoveryTimer = null;
    }
    if (diagTimer) {
        clearInterval(diagTimer);
        diagTimer = null;
    }
    if (leaderClient) {
        const client = leaderClient;
        leaderClient = null;
        try {
            await client.query('SELECT pg_advisory_unlock($1)', [WATCHDOG_LOCK_KEY]);
        } catch {
            /* connection already dead */
        }
        try {
            await client.end();
        } catch {
            /* already ended */
        }
    }
}

function scheduleReacquire(): void {
    if (stoppedExplicitly || reacquireTimer) return;
    reacquireTimer = setTimeout(() => {
        reacquireTimer = null;
        if (stoppedExplicitly) return;
        console.log('[watchdog] attempting to reacquire leadership...');
        startWatchdog().catch(err => console.error('[watchdog] re-acquisition failed:', err));
    }, REACQUIRE_BACKOFF_MS);
    reacquireTimer.unref();
}

export async function startWatchdog(): Promise<boolean> {
    stoppedExplicitly = false;
    leaderClient = await createDedicatedClient();

    leaderClient.on('error', (err) => {
        console.error('[watchdog] leader client error — releasing leadership for re-arm:', err);
        releaseLeadership().catch(() => {});
        scheduleReacquire();
    });

    const acquired = await tryAcquireLeader(leaderClient);
    if (!acquired) {
        console.log('[watchdog] another worker holds the leadership lock; will retry');
        await leaderClient.end().catch(() => {});
        leaderClient = null;
        scheduleReacquire();
        return false;
    }

    console.log(`[watchdog] acquired leadership (lock=${WATCHDOG_LOCK_KEY}); recovery every ${WATCHDOG_INTERVAL_MS}ms, diagnostics every ${DIAG_INTERVAL_MS}ms`);

    // Run once immediately so signs of life appear in logs without waiting an interval.
    recoverStuckJobs().catch(err => console.error('[watchdog] initial recovery failed:', err));
    reportQueueHealth().catch(err => console.error('[diag] initial report failed:', err));

    recoveryTimer = setInterval(() => {
        recoverStuckJobs().catch(err => console.error('[watchdog] recovery failed:', err));
    }, WATCHDOG_INTERVAL_MS);
    recoveryTimer.unref();

    diagTimer = setInterval(() => {
        reportQueueHealth().catch(err => console.error('[diag] report failed:', err));
    }, DIAG_INTERVAL_MS);
    diagTimer.unref();

    return true;
}

export async function stopWatchdog(): Promise<void> {
    stoppedExplicitly = true;
    if (reacquireTimer) {
        clearTimeout(reacquireTimer);
        reacquireTimer = null;
    }
    await releaseLeadership();
}

async function recoverStuckJobs(): Promise<void> {
    const reclaimed = await reclaimStuckJobs(STUCK_AFTER_MINUTES);
    if (reclaimed > 0) {
        console.warn(`[watchdog] reclaimed ${reclaimed} rows stuck in auto_processing for >${STUCK_AFTER_MINUTES}min`);
    }
}

async function reportQueueHealth(): Promise<void> {
    const byStatus = await queueHealth();
    console.log('[diag] queue health (scrape_type=http_request):');
    if (byStatus.length === 0) {
        console.log('  (no rows)');
    } else {
        for (const r of byStatus) {
            const flag = r.oldest_age_seconds > STALE_AGE_WARN_SECONDS ? ' STALE' : '';
            console.log(
                `  ${r.status.padEnd(30)} count=${String(r.count).padStart(6)}  oldest=${r.oldest_age_seconds}s${flag}`
            );
        }
    }

    console.log('[diag] htmlparser targets:');
    for (const t of getTargetStats()) {
        console.log(
            `  ${t.url.padEnd(40)} active=${t.active} failures=${t.failures} cooldown=${t.cooldownRemainingMs}ms total=${t.totalRequests}`
        );
    }
}
