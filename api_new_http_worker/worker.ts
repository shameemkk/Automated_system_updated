import PQueue from 'p-queue';
import { config } from './config.js';
import { pool, claimJobs, countQueued, retryErrorJobs } from './db.js';
import { Batcher } from './batcher.js';
import { processRow, type Stats } from './processor.js';
import { startWatchdog, stopWatchdog } from './watchdog.js';
import { checkAllTargets, getTargetStats } from './api-client.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const stats: Stats = { processed: 0, errors: 0, escalated: 0, active: 0 };

const queue = new PQueue({ concurrency: config.MAX_CONCURRENCY });
const batcher = new Batcher();

let shuttingDown = false;
let paused = false;
let statsTimer: NodeJS.Timeout | null = null;

async function preflight(): Promise<void> {
    if (!config.API_HEALTH_CHECK_AT_STARTUP) return;
    const results = await checkAllTargets();
    let anyOk = false;
    for (const r of results) {
        if (r.ok) {
            console.log(`[startup] target OK: ${r.url} (${r.detail})`);
            anyOk = true;
        } else {
            console.warn(`[startup] target UNREACHABLE: ${r.url} — ${r.detail}`);
        }
    }
    if (!anyOk) {
        console.warn('[startup] WARNING: no API targets are currently reachable. Worker will start anyway; targets may come up later.');
    }
}

function logStats(): void {
    const targetSummary = getTargetStats()
        .map(t => `${t.url}(active=${t.active},fail=${t.failures}${t.cooldownRemainingMs > 0 ? `,cool=${t.cooldownRemainingMs}ms` : ''})`)
        .join(' ');
    console.log(
        `[stats] processed=${stats.processed} errors=${stats.errors} escalated=${stats.escalated} active=${stats.active} qsize=${queue.size} qpending=${queue.pending} pending_updates=${batcher.size()} dropped=${batcher.droppedCount()} | ${targetSummary}`
    );
}

async function mainLoop(): Promise<void> {
    let backoffMs = 1_000;
    const maxBackoff = 60_000;

    console.log(
        `[worker] starting — concurrency=${config.MAX_CONCURRENCY}, claim_batch_max=${config.CLAIM_BATCH_MAX}, batch_flush=${config.BATCH_FLUSH_SIZE} or ${config.BATCH_FLUSH_INTERVAL_MS}ms`
    );

    await preflight();
    batcher.start();
    await startWatchdog();

    statsTimer = setInterval(logStats, config.STATS_LOG_INTERVAL_MS);
    statsTimer.unref();

    try {
        const queued = await countQueued();
        console.log(`[startup] queued rows: ${queued}`);
        if (queued === 0) {
            const retried = await retryErrorJobs();
            if (retried > 0) console.log(`[startup] re-queued ${retried} error jobs`);
        }
    } catch (err) {
        console.error('[startup] preflight DB check failed:', err);
    }

    while (!shuttingDown) {
        try {
            // Back-pressure: pause claims if the update buffer is saturated.
            if (paused) {
                if (batcher.hasDrainedBelow(config.RESUME_THRESHOLD)) {
                    paused = false;
                    console.log(`[worker] resuming claims (pending_updates=${batcher.size()})`);
                } else {
                    await sleep(1_000);
                    continue;
                }
            } else if (batcher.isFull()) {
                paused = true;
                console.warn(`[worker] back-pressure engaged: pending_updates=${batcher.size()} >= MAX_PENDING_UPDATES=${config.MAX_PENDING_UPDATES}; pausing claims`);
                continue;
            }

            const slotsAvailable = config.MAX_CONCURRENCY - queue.pending - queue.size;
            const claimSize = Math.min(slotsAvailable, config.CLAIM_BATCH_MAX);

            if (claimSize > 0) {
                const jobs = await claimJobs(claimSize);

                if (jobs.length > 0) {
                    backoffMs = 1_000;
                    if (config.DEBUG) console.log(`[worker] claimed ${jobs.length} jobs`);
                    for (const row of jobs) {
                        queue.add(() => processRow(row, batcher, stats));
                    }
                } else if (queue.size === 0 && queue.pending === 0) {
                    const retried = await retryErrorJobs();
                    if (retried > 0) {
                        console.log(`[worker] re-queued ${retried} error jobs`);
                        backoffMs = 1_000;
                        continue;
                    }
                    if (config.DEBUG) console.log(`[worker] queue empty, sleeping ${backoffMs}ms`);
                    await sleep(backoffMs);
                    backoffMs = Math.min(backoffMs * 2, maxBackoff);
                } else {
                    // Some jobs in flight, none claimable — wait briefly for slots
                    await sleep(500);
                }
            } else {
                // All slots full — wait briefly for completions
                await sleep(200);
            }
        } catch (err) {
            console.error('[worker] main loop error:', err);
            await sleep(5_000);
        }
    }
}

let shutdownStarted = false;

async function gracefulShutdown(signal: string): Promise<void> {
    if (shutdownStarted) return;
    shutdownStarted = true;

    console.log(`\n[worker] received ${signal}, shutting down...`);
    shuttingDown = true;

    if (statsTimer) {
        clearInterval(statsTimer);
        statsTimer = null;
    }

    console.log(`[worker] waiting up to ${config.SHUTDOWN_GRACE_MS}ms for ${queue.pending + queue.size} active/queued jobs...`);
    await Promise.race([
        queue.onIdle(),
        sleep(config.SHUTDOWN_GRACE_MS),
    ]);

    const stillActive = queue.pending + queue.size;
    if (stillActive > 0) {
        console.warn(`[worker] shutdown grace expired; abandoning ${stillActive} jobs (watchdog will reclaim)`);
    }

    batcher.stop();
    await stopWatchdog();
    await batcher.drain();

    await pool.end().catch(err => console.error('[worker] pool.end error:', err));

    logStats();
    console.log('[worker] goodbye');
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
    console.error('[worker] unhandledRejection:', reason);
});

mainLoop().catch(err => {
    console.error('[worker] fatal crash:', err);
    process.exit(1);
});
