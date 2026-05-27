import type pkg from 'pg';
import { config } from './config.js';
import {
    createDedicatedClient,
    queueHealth,
    reclaimStuckJobs,
} from './db.js';
import { getTargetStats } from './api-client.js';

let leaderClient: pkg.Client | null = null;
let recoveryTimer: NodeJS.Timeout | null = null;
let diagTimer: NodeJS.Timeout | null = null;
let reacquireTimer: NodeJS.Timeout | null = null;
let stoppedExplicitly = false;

async function tryAcquireLeader(client: pkg.Client): Promise<boolean> {
    const { rows } = await client.query<{ got: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS got',
        [config.WATCHDOG_LOCK_KEY]
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
            await client.query('SELECT pg_advisory_unlock($1)', [config.WATCHDOG_LOCK_KEY]);
        } catch { /* connection already dead */ }
        try {
            await client.end();
        } catch { /* already ended */ }
    }
}

function scheduleReacquire(): void {
    if (stoppedExplicitly || reacquireTimer) return;
    reacquireTimer = setTimeout(() => {
        reacquireTimer = null;
        if (stoppedExplicitly) return;
        console.log('[watchdog] attempting to reacquire leadership...');
        startWatchdog().catch(err => console.error('[watchdog] re-acquisition failed:', err));
    }, config.WATCHDOG_REACQUIRE_MS);
    reacquireTimer.unref();
}

export async function startWatchdog(): Promise<boolean> {
    stoppedExplicitly = false;

    let client: pkg.Client;
    try {
        client = await createDedicatedClient();
    } catch (err) {
        console.error('[watchdog] failed to open dedicated client; will retry:', err);
        scheduleReacquire();
        return false;
    }

    client.on('error', (err) => {
        console.error('[watchdog] leader client error — releasing leadership for re-arm:', err);
        releaseLeadership().catch(() => {});
        scheduleReacquire();
    });

    let acquired = false;
    try {
        acquired = await tryAcquireLeader(client);
    } catch (err) {
        console.error('[watchdog] failed to acquire advisory lock; will retry:', err);
        await client.end().catch(() => {});
        scheduleReacquire();
        return false;
    }

    if (!acquired) {
        console.log('[watchdog] another worker holds the leadership lock; will retry');
        await client.end().catch(() => {});
        scheduleReacquire();
        return false;
    }

    leaderClient = client;
    console.log(`[watchdog] acquired leadership (lock=${config.WATCHDOG_LOCK_KEY}); recovery every ${config.WATCHDOG_INTERVAL_MS}ms, diagnostics every ${config.DIAG_INTERVAL_MS}ms`);

    recoverStuckJobs().catch(err => console.error('[watchdog] initial recovery failed:', err));
    reportQueueHealth().catch(err => console.error('[diag] initial report failed:', err));

    recoveryTimer = setInterval(() => {
        recoverStuckJobs().catch(err => console.error('[watchdog] recovery failed:', err));
    }, config.WATCHDOG_INTERVAL_MS);
    recoveryTimer.unref();

    diagTimer = setInterval(() => {
        reportQueueHealth().catch(err => console.error('[diag] report failed:', err));
    }, config.DIAG_INTERVAL_MS);
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
    const reclaimed = await reclaimStuckJobs(config.STUCK_AFTER_MINUTES);
    if (reclaimed > 0) {
        console.warn(`[watchdog] reclaimed ${reclaimed} rows stuck in auto_processing for >${config.STUCK_AFTER_MINUTES}min`);
    }
}

async function reportQueueHealth(): Promise<void> {
    const byStatus = await queueHealth();
    console.log('[diag] queue health (scrape_type=http_request):');
    if (byStatus.length === 0) {
        console.log('  (no rows)');
    } else {
        for (const r of byStatus) {
            const flag = r.oldest_age_seconds > config.STALE_AGE_WARN_SECONDS ? ' STALE' : '';
            console.log(
                `  ${r.status.padEnd(30)} count=${String(r.count).padStart(6)}  oldest=${r.oldest_age_seconds}s${flag}`
            );
        }
    }

    console.log('[diag] api targets:');
    for (const t of getTargetStats()) {
        console.log(
            `  ${t.url.padEnd(40)} active=${t.active} failures=${t.failures} cooldown=${t.cooldownRemainingMs}ms total=${t.totalRequests} failed=${t.totalFailures}`
        );
    }
}
