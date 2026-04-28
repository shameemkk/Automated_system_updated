import * as dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
dotenv.config({ path: envPath });

// Dummy values — never used. src/config.ts exits at import time if these are
// missing, but installSupabaseStub() replaces supabase.rpc/.from before any
// request would be made, so no traffic ever reaches Supabase.
process.env.SUPABASE_URL ||= 'http://localhost.test';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

if (!process.env.MILLION_VERIFIER_API_KEY || !process.env.TRYKITT_API_KEY) {
    console.error(
        'MILLION_VERIFIER_API_KEY and TRYKITT_API_KEY must be set in email_verification/.env\n' +
        '(real keys — this test hits the live Million Verifier and TryKitt APIs).'
    );
    process.exit(1);
}

const { installSupabaseStub, store, dumpStore } = await import('./supabase-stub.ts');
const { seedScraperRows, seedClientResults } = await import('./fixtures.ts');
const { processRow, mainLoop } = await import('../src/worker.ts');
const { setShuttingDown, queue } = await import('../src/config.ts');
const { sleep } = await import('../src/utils.ts');

installSupabaseStub();
store.scraperRows = JSON.parse(JSON.stringify(seedScraperRows));
store.clientResults = JSON.parse(JSON.stringify(seedClientResults));

const loopMode = process.argv.includes('--loop');

if (loopMode) {
    console.log('=== LOOP MODE: starting mainLoop, will shut down after 3s ===\n');
    mainLoop().catch(err => console.error('mainLoop crashed:', err));
    await sleep(3000);
    console.log('\n=== Triggering shutdown ===');
    setShuttingDown(true);
    await queue.onIdle();
    await sleep(200);
} else {
    console.log('=== SCENARIO MODE: processing each seeded row in order ===\n');
    for (const row of store.scraperRows) {
        const claim = {
            record_id: row.id,
            emails: row.emails,
            url: row.url,
            automation_id: row.automation_id
        };
        row.status = 'e_v_processing';
        console.log(`\n--- Row ${row.id} (url=${row.url}, emails=${JSON.stringify(row.emails)}) ---`);
        try {
            await processRow(claim);
        } catch (err) {
            console.error(`Row ${row.id} threw:`, err);
        }
    }
}

console.log('\n=== FINAL STORE STATE ===');
console.log(dumpStore());

process.exit(0);
