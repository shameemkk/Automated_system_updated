import { batchUpdate, type PendingUpdate } from './db.js';
import { config } from './config.js';

interface BufferedUpdate extends PendingUpdate {
    _flushRetries?: number;
}

export class Batcher {
    private buffer: BufferedUpdate[] = [];
    private intervalHandle: NodeJS.Timeout | null = null;
    private activeFlush: Promise<void> | null = null;
    private dropped = 0;

    push(update: PendingUpdate): void {
        this.buffer.push(update);
        if (this.buffer.length >= config.BATCH_FLUSH_SIZE) {
            // Fire-and-forget — caller doesn't need to await
            this.flush().catch(err => console.error('[batcher] size-triggered flush failed:', err));
        }
    }

    size(): number {
        return this.buffer.length;
    }

    isFull(): boolean {
        return this.buffer.length >= config.MAX_PENDING_UPDATES;
    }

    hasDrainedBelow(threshold: number): boolean {
        return this.buffer.length < threshold;
    }

    droppedCount(): number {
        return this.dropped;
    }

    start(): void {
        if (this.intervalHandle) return;
        this.intervalHandle = setInterval(() => {
            this.flush().catch(err => console.error('[batcher] periodic flush failed:', err));
        }, config.BATCH_FLUSH_INTERVAL_MS);
        this.intervalHandle.unref();
    }

    stop(): void {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
    }

    async flush(): Promise<void> {
        if (this.activeFlush) {
            return this.activeFlush;
        }
        this.activeFlush = this.doFlush().finally(() => {
            this.activeFlush = null;
        });
        return this.activeFlush;
    }

    private async doFlush(): Promise<void> {
        if (this.buffer.length === 0) return;

        const batch = this.buffer.splice(0);
        const clean: PendingUpdate[] = batch.map(({ _flushRetries, ...rest }) => rest);

        try {
            const affected = await batchUpdate(clean);
            if (config.DEBUG) {
                console.log(`[batcher] flushed ${batch.length} updates, ${affected} rows affected`);
            } else {
                console.log(`[batcher] flushed ${batch.length} updates`);
            }
        } catch (err) {
            const msg = (err as Error)?.message ?? String(err);
            console.error(`[batcher] flush failed for ${batch.length} updates: ${msg}`);
            this.requeueFailed(batch);
        }
    }

    private requeueFailed(batch: BufferedUpdate[]): void {
        const retriable: BufferedUpdate[] = [];
        const dropped: BufferedUpdate[] = [];

        for (const update of batch) {
            const retries = (update._flushRetries ?? 0) + 1;
            if (retries < config.BATCH_MAX_FLUSH_RETRIES) {
                retriable.push({ ...update, _flushRetries: retries });
            } else {
                dropped.push(update);
            }
        }

        if (retriable.length > 0) {
            this.buffer.push(...retriable);
            console.warn(
                `[batcher] re-queued ${retriable.length} updates (attempt ${retriable[0]._flushRetries}/${config.BATCH_MAX_FLUSH_RETRIES})`
            );
        }

        if (dropped.length > 0) {
            this.dropped += dropped.length;
            console.error(
                `[batcher] dropped ${dropped.length} updates after ${config.BATCH_MAX_FLUSH_RETRIES} failed flush attempts. IDs: ${dropped.map(u => u.id).join(', ')}`
            );
        }
    }

    /**
     * Drain on shutdown. Loops until empty or until a single flush cycle
     * makes no progress (e.g., DB unreachable). Worst case: bounded by
     * BATCH_MAX_FLUSH_RETRIES.
     */
    async drain(): Promise<void> {
        while (this.buffer.length > 0) {
            const before = this.buffer.length;
            console.log(`[batcher] draining ${before} remaining updates...`);
            await this.flush();
            if (this.buffer.length >= before) {
                console.error(
                    `[batcher] drain stalled: ${this.buffer.length} updates unflushable; abandoning. Watchdog will reclaim via auto_processing timeout.`
                );
                break;
            }
        }
    }
}
