import { createClient } from '@supabase/supabase-js';
import PQueue from 'p-queue';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const MILLION_VERIFIER_API_KEY = process.env.MILLION_VERIFIER_API_KEY || '';
const TRYKITT_API_KEY = process.env.TRYKITT_API_KEY || '';

const MAX_CONCURRENCY = 150; // Rate limit: 6 req/sec
const EXTERNAL_API_TIMEOUT = 300000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
    process.exit(1);
}

if (!MILLION_VERIFIER_API_KEY) {
    console.error('Missing MILLION_VERIFIER_API_KEY in .env');
    process.exit(1);
}

if (!TRYKITT_API_KEY) {
    console.error('Missing TRYKITT_API_KEY in .env');
    process.exit(1);
}



// Stats
const stats = {
    processed: 0,
    errors: 0,
    active: 0
};

// Supabase Client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

// Concurrency Queue
const queue = new PQueue({ concurrency: MAX_CONCURRENCY });

let shuttingDown = false;

// --- UTILITIES ---

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const FREE_EMAIL_DOMAINS = ["gmail.com", "yahoo.com", "ymail.com", "zoho.com", "proton.me", "protonmail.com", "icloud.com", "me.com", "mac.com"];
const MICROSOFT_ESP_DOMAINS = ["outlook.com", "office365.com", "hotmail.com", "microsoft"];

// Check if ESP data contains Microsoft/Outlook
function isMicrosoftESP(data: any): boolean {
    const dataStr = (JSON.stringify(data) || '').toLowerCase();
    return MICROSOFT_ESP_DOMAINS.some(s => dataStr.includes(s));
}

// Verify email using Million Verifier API
async function verifyEmail(email: string): Promise<any> {
    try {
        const response = await axios.get('https://api.millionverifier.com/api/v3/?api=XCHdK439PM0E03r238UdAeNV4', {
            params: {
                email: email,
                api_key: MILLION_VERIFIER_API_KEY
            },
            timeout: EXTERNAL_API_TIMEOUT
        });
        return response.data;
    } catch (error) {
        console.error(`Error verifying email ${email}:`, error);
        throw error;
    }
}

// Verify email using TryKitt API (fallback for catch_all)
async function verifyEmailWithTryKitt(email: string): Promise<any> {
    try {
        const response = await axios.post('https://api.trykitt.ai/job/verify_email', {
            email: email,
            customData: "myInternalId",
            callbackURL: "only_used_if_realtime_param_is_false",
            realtime: true,
            treatAliasesAsValid: true
        }, {
            headers: {
                'x-api-key': TRYKITT_API_KEY,
                'Content-Type': 'application/json'
            },
            timeout: EXTERNAL_API_TIMEOUT
        });
        return response.data;
    } catch (error) {
        console.error(`Error verifying email with TryKitt ${email}:`, error);
        throw error;
    }
}



// --- CORE WORKER LOGIC ---

// Extract ALL unique domains from emails array (including free email domains for ESP checking)
function getAllUniqueDomainsFromEmails(emails: string[]): string[] {
    if (!emails || emails.length === 0) return [];
    const domains = emails
        .map(email => email.split('@')[1]?.toLowerCase())
        .filter((d): d is string => !!d);
    return [...new Set(domains)];
}

async function processRow(row: any) {
    stats.active++;

    try {
        // Deduplicate emails - lowercase and unique
        const uniqueEmails: string[] = [...new Set((row.emails as string[]).map((e: string) => e.toLowerCase()))];
        
        // Filter and prioritize emails based on facility management and business keywords
        const priorityKeywords = /facility|facilities|facilitiesmanager|facilitymanager|fm|buildingmanager|propertymanager|maintenance|maint|repairs|janitorial|janitor|custodian|upkeep|operations|ops|operationmanager|facilityservices|operationsmanager|buildingops|operationslead|siteoperations|sitelead|sitecoordinator|plantmanager|plantops|plantmaintenance|buildingservices|buildingmaintenance|facilityservices|property|propertymanagement|realestate|estate|estates|premises|premisesmanager|propertycare|buildingcare|cleaning|custodial|sanitation|cleaner|maintenancecrew|maintenanceoffice|owner|founder|cofounder|partner|co-owner|boss|director|managingdirector|managingpartner|md|principal|proprietor/i;
        
        const filteredEmails = uniqueEmails
            .filter(Boolean) // Remove empty/null emails
            .sort((a, b) => {
                const aMatch = priorityKeywords.test(a) ? 1 : 0;
                const bMatch = priorityKeywords.test(b) ? 1 : 0;
                return bMatch - aMatch; // Sort priority emails first
            })
            .slice(0, 5); // Limit to top 5 emails
        
        console.log(`Row ${row.record_id}: Filtered ${uniqueEmails.length} emails down to ${filteredEmails.length} priority emails`);
        
        // Extract ALL unique domains from filtered emails array (including free domains for ESP checking)
        const domains = getAllUniqueDomainsFromEmails(filteredEmails);
        
        if (domains.length === 0) {
            console.log(`Row ${row.record_id}: No email domains found`);
            return;
        }

        // Build domain ESP mapping
        const domainESPMap = new Map<string, boolean>();

        // Check MX records for each domain
        for (const domain of domains) {
            // Skip ESP check for free email domains
            const isFreeEmailDomain = FREE_EMAIL_DOMAINS.some(d => domain.includes(d));
            
            if (isFreeEmailDomain) {
                console.log(`Row ${row.record_id} domain ${domain} is free email domain - skipping ESP check`);
                domainESPMap.set(domain, false); // Not Microsoft
                continue;
            }

            const apiUrl = `https://dns.google/resolve?name=${domain}&type=MX`;

            const response = await axios.get(apiUrl, {
                timeout: EXTERNAL_API_TIMEOUT
            });

            const data = response.data;
            const isMicrosoft = isMicrosoftESP(data);

            if (isMicrosoft) {
                console.log(`Row ${row.record_id} domain ${domain} uses Microsoft ESP`);
                domainESPMap.set(domain, true);
            } else {
                console.log(`Row ${row.record_id} domain ${domain} is NOT Microsoft`);
                domainESPMap.set(domain, false);
            }
        }

        const verifiedEmails: string[] = [];

        // Process each email individually based on its domain
        for (const email of filteredEmails) {
            const emailDomain = email.split('@')[1]?.toLowerCase();
            if (!emailDomain) continue;

            const isMicrosoftDomain = domainESPMap.get(emailDomain);

            if (isMicrosoftDomain) {
                console.log(`Row ${row.record_id} email ${email} uses Microsoft ESP - skipping verification`);
            } else {
                console.log(`Row ${row.record_id} email ${email} is NOT Microsoft - verifying...`);
                try {
                    const verificationResult = await verifyEmail(email);
                    console.log(`Row ${row.record_id} email ${email} verification:`, verificationResult);
                    
                    // Check if email is verified based on Million Verifier response
                    // result: "ok" means deliverable, quality: "good" is additional validation
                    if (verificationResult.result === 'ok' && verificationResult.resultcode === 1) {
                        verifiedEmails.push(email);
                        console.log(`Row ${row.record_id} email ${email} VERIFIED - quality: ${verificationResult.quality}`);
                    } else if (verificationResult.result === 'catch_all') {
                        // Fallback to TryKitt for catch_all results
                        console.log(`Row ${row.record_id} email ${email} is catch_all - trying TryKitt...`);
                        try {
                            const tryKittResult = await verifyEmailWithTryKitt(email);
                            console.log(`Row ${row.record_id} email ${email} TryKitt result:`, tryKittResult);
                            
                            // Check TryKitt result - validity: "valid" means deliverable
                            if (tryKittResult.validity === 'valid' && tryKittResult.validSMTP === true) {
                                verifiedEmails.push(email);
                                console.log(`Row ${row.record_id} email ${email} VERIFIED via TryKitt - mxDomain: ${tryKittResult.mxDomain}`);
                            } else {
                                console.log(`Row ${row.record_id} email ${email} NOT VERIFIED via TryKitt - validity: ${tryKittResult.validity}, reason: ${tryKittResult.reason}`);
                            }
                        } catch (tryKittError) {
                            console.error(`Row ${row.record_id} TryKitt verification failed for ${email}:`, tryKittError);
                        }
                    } else {
                        console.log(`Row ${row.record_id} email ${email} NOT VERIFIED - result: ${verificationResult.result}, subresult: ${verificationResult.subresult}`);
                    }
                } catch (error) {
                    console.error(`Row ${row.record_id} failed to verify email ${email}:`, error);
                }
            }
        }

        // Update client_query_results with verified emails if we have any
        if (verifiedEmails.length > 0 && row.url) {
            console.log(`Row ${row.record_id}: Adding ${verifiedEmails.length} verified emails to client_query_results`);
            
            // Find matching client_query_results by full URL
            const { data: matchingResults, error: findError } = await supabase
                .from('client_query_results')
                .select('id, verified_emails')
                .eq('website', row.url)
                .limit(1);

            if (findError) {
                console.error(`Row ${row.record_id}: Error finding client_query_results:`, findError);
            } else if (matchingResults && matchingResults.length > 0) {
                const clientResult = matchingResults[0];
                
                // Merge with existing verified emails (avoid duplicates)
                const existingEmails = clientResult.verified_emails || [];
                const allVerifiedEmails = [...new Set([...existingEmails, ...verifiedEmails])];

                // Update client_query_results
                const { error: updateError } = await supabase
                    .from('client_query_results')
                    .update({ 
                        verified_emails: allVerifiedEmails,
                        mode: 'auto_email_verified',
                        gpt_process : 'auto_queued'
                    })
                    .eq('id', clientResult.id);

                if (updateError) {
                    console.error(`Row ${row.record_id}: Error updating client_query_results:`, updateError);
                } else {
                    console.log(`Row ${row.record_id}: Successfully updated client_query_results (${clientResult.id}) with ${verifiedEmails.length} new verified emails`);
                }
            } else {
                console.log(`Row ${row.record_id}: No matching client_query_results found for URL: ${row.url}`);
            }
        }

        // Update status to auto_final_completed
        await supabase
            .from('email_scraper_node')
            .update({ status: 'auto_final_completed' })
            .eq('id', row.record_id);

    } catch (error) {
        console.error(`Error processing row ${row.record_id}:`, error);
        stats.errors++;
        
        // Update status to error
        await supabase
            .from('email_scraper_node')
            .update({ status: 'e_v_error' })
            .eq('id', row.record_id);
    } finally {
        stats.active--;
        stats.processed++;
        console.log(`Finished row ${row.record_id}. Processed: ${stats.processed}, Errors: ${stats.errors}`);
    }
}

async function fetchAndClaim(slots: number): Promise<any[]> {
    if (slots <= 0) return [];

    try {
        const { data, error } = await supabase.rpc('fetch_email_verification_records', {
            batch_size: slots
        });

        if (error) {
            console.error('Error fetching rows via RPC:', error);
            return [];
        }

        return data || [];
    } catch (error) {
        console.error('RPC call failed:', error);
        return [];
    }
}

async function mainLoop() {
    let backoffMs = 1000;
    const maxBackoff = 60000;

    console.log(`Starting worker with max concurrency: ${MAX_CONCURRENCY} `);

    const { count: queuedCount, error: qErr } = await supabase
        .from('email_scraper_node')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'auto_completed');

    if (qErr) {
        console.error("Startup check failed.", qErr);
    } else {
        console.log(`Startup Status: completed=${queuedCount}`);
    }

    while (!shuttingDown) {
        try {
            const currentPending = queue.pending;
            const slotsAvailable = MAX_CONCURRENCY - currentPending;

            if (slotsAvailable > 0) {
                const jobs = await fetchAndClaim(slotsAvailable);

                if (jobs.length > 0) {
                    backoffMs = 1000;
                    console.log(`Claimed ${jobs.length} jobs.`);
                    jobs.forEach(row => {
                        queue.add(() => processRow(row));
                    });
                } else {
                    console.log(`Queue empty. Waiting ${backoffMs}ms...`);
                    await sleep(backoffMs);
                    backoffMs = Math.min(backoffMs * 2, maxBackoff);
                }
            }
            
            // Small delay between loop iterations to prevent tight spinning
            await sleep(100);
        } catch (error) {
            console.error("Main loop error:", error);
            await sleep(5000);
        }
    }
}

// --- SHUTDOWN HANDLING ---

async function gracefulShutdown(signal: string) {
    console.log(`\nReceived ${signal}. Shutting down...`);
    shuttingDown = true;
    console.log('Waiting for active jobs to complete...');
    await queue.onIdle();
    console.log('Goodbye.');
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

mainLoop().catch(err => {
    console.error('Fatal crash:', err);
    process.exit(1);
});
