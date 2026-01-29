import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

async function testConnection() {
    try {
        console.log('Testing Supabase connection...');
        
        // Test basic connection
        const { count, error } = await supabase
            .from('email_scraper_node')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'auto_need_outscraper')
            .eq('scrape_type', 'outscraper');

        if (error) {
            console.error('Connection failed:', error);
            return;
        }

        console.log(`✅ Connection successful! Found ${count} auto_need_outscraper jobs.`);

        // Test direct query
        const { data: testData, error: testError } = await supabase
            .from('email_scraper_node')
            .select('*')
            .eq('status', 'auto_need_outscraper')
            .eq('scrape_type', 'outscraper')
            .limit(1);

        if (testError) {
            console.error('Direct query test failed:', testError);
            return;
        }

        console.log(`✅ Direct query test successful! Retrieved ${testData?.length || 0} jobs.`);

        // Test RPC function for stale pending jobs
        const { data: pendingData, error: pendingError } = await supabase
            .rpc('get_stale_pending_jobs', { batch_size: 5 });

        if (pendingError) {
            console.error('RPC function test failed:', pendingError);
            return;
        }

        console.log(`✅ RPC function test successful! Retrieved ${pendingData?.length || 0} stale pending jobs.`);

    } catch (err) {
        console.error('Test failed:', err);
    }
}

testConnection();