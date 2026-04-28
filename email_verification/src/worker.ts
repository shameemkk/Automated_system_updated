import {
    FREE_EMAIL_DOMAINS,
    MAX_CONCURRENCY,
    isShuttingDown,
    queue,
    setShuttingDown,
    stats,
    supabase
} from './config.ts';
import { resolveMxRecord, verifyEmail, verifyEmailWithTryKitt } from './api.ts';
import {
    dedupeEmails,
    getAllUniqueDomainsFromEmails,
    isMicrosoftESP,
    prioritizeAndLimitEmails,
    sleep
} from './utils.ts';

export async function processRow(row: any) {
    stats.active++;

    try {
        const uniqueEmails = dedupeEmails(row.emails as string[]);

        const filteredEmails = prioritizeAndLimitEmails(uniqueEmails);

        console.log(`Row ${row.record_id}: Filtered ${uniqueEmails.length} emails down to ${filteredEmails.length} priority emails`);

        const domains = getAllUniqueDomainsFromEmails(filteredEmails);

        if (domains.length === 0) {
            console.log(`Row ${row.record_id}: No email domains found`);
            return;
        }

        const domainESPMap = new Map<string, boolean>();

        for (const domain of domains) {
            const isFreeEmailDomain = FREE_EMAIL_DOMAINS.some(d => domain.includes(d));

            if (isFreeEmailDomain) {
                console.log(`Row ${row.record_id} domain ${domain} is free email domain - skipping ESP check`);
                domainESPMap.set(domain, false);
                continue;
            }

            const data = await resolveMxRecord(domain);
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
        const rejectedEmails: Record<string, string> = {};

        for (const email of filteredEmails) {
            const emailDomain = email.split('@')[1]?.toLowerCase();
            if (!emailDomain) continue;

            const isMicrosoftDomain = domainESPMap.get(emailDomain);

            if (isMicrosoftDomain) {
                rejectedEmails[email] = 'system:skipped_microsoft_esp';
                console.log(`Row ${row.record_id} email ${email} uses Microsoft ESP - skipping verification`);
            } else {
                console.log(`Row ${row.record_id} email ${email} is NOT Microsoft - verifying...`);
                try {
                    const verificationResult = await verifyEmail(email);
                    console.log(`Row ${row.record_id} email ${email} verification:`, verificationResult);

                    if (verificationResult.result === 'ok' && verificationResult.resultcode === 1) {
                        verifiedEmails.push(email);
                        console.log(`Row ${row.record_id} email ${email} VERIFIED - quality: ${verificationResult.quality}`);
                    } else if (verificationResult.result === 'catch_all') {
                        console.log(`Row ${row.record_id} email ${email} is catch_all - trying TryKitt...`);
                        try {
                            const tryKittResult = await verifyEmailWithTryKitt(email);
                            console.log(`Row ${row.record_id} email ${email} TryKitt result:`, tryKittResult);

                            if (tryKittResult.validity === 'valid' && tryKittResult.validSMTP === true) {
                                verifiedEmails.push(email);
                                console.log(`Row ${row.record_id} email ${email} VERIFIED via TryKitt - mxDomain: ${tryKittResult.mxDomain}`);
                            } else {
                                const validity = tryKittResult.validity ?? 'unknown';
                                rejectedEmails[email] = tryKittResult.reason
                                    ? `trykitt:${validity}:${tryKittResult.reason}`
                                    : `trykitt:${validity}`;
                                console.log(`Row ${row.record_id} email ${email} NOT VERIFIED via TryKitt - validity: ${tryKittResult.validity}, reason: ${tryKittResult.reason}`);
                            }
                        } catch (tryKittError) {
                            rejectedEmails[email] = `trykitt:error:${tryKittError instanceof Error ? tryKittError.message : String(tryKittError)}`;
                            console.error(`Row ${row.record_id} TryKitt verification failed for ${email}:`, tryKittError);
                        }
                    } else {
                        const result = verificationResult.result ?? 'unknown';
                        rejectedEmails[email] = verificationResult.subresult
                            ? `mv:${result}:${verificationResult.subresult}`
                            : `mv:${result}`;
                        console.log(`Row ${row.record_id} email ${email} NOT VERIFIED - result: ${verificationResult.result}, subresult: ${verificationResult.subresult}`);
                    }
                } catch (error) {
                    rejectedEmails[email] = `mv:error:${error instanceof Error ? error.message : String(error)}`;
                    console.error(`Row ${row.record_id} failed to verify email ${email}:`, error);
                }
            }
        }

        if (row.url) {
            const { data: matchingResults, error: findError } = await supabase
                .from('client_query_results')
                .select('id, verified_emails, automation_id')
                .eq('website', row.url)
                .eq('automation_id', row.automation_id)
                .limit(1);

            if (findError) {
                console.error(`Row ${row.record_id}: Error finding client_query_results:`, findError);
            } else if (matchingResults && matchingResults.length > 0) {
                const clientResult = matchingResults[0];

                if (verifiedEmails.length > 0) {
                    console.log(`Row ${row.record_id}: Adding ${verifiedEmails.length} verified emails to client_query_results`);

                    const existingEmails = clientResult.verified_emails || [];
                    const allVerifiedEmails = [...new Set([...existingEmails, ...verifiedEmails])];

                    const { error: updateError } = await supabase
                        .from('client_query_results')
                        .update({
                            verified_emails: allVerifiedEmails,
                            mode: 'auto_email_verified',
                            gpt_process: 'auto_queued'
                        })
                        .eq('id', clientResult.id);

                    if (updateError) {
                        console.error(`Row ${row.record_id}: Error updating client_query_results:`, updateError);
                    } else {
                        console.log(`Row ${row.record_id}: Successfully updated client_query_results (${clientResult.id}) with ${verifiedEmails.length} new verified emails`);
                    }
                } else {
                    console.log(`Row ${row.record_id}: No verified emails found - updating client_query_results with no valid emails status`);

                    const { error: updateError } = await supabase
                        .from('client_query_results')
                        .update({
                            mode: 'auto_completed_no_valid_emails',
                            gpt_process: 'auto_completed'
                        })
                        .eq('id', clientResult.id);

                    if (updateError) {
                        console.error(`Row ${row.record_id}: Error updating client_query_results for no valid emails:`, updateError);
                    } else {
                        console.log(`Row ${row.record_id}: Successfully updated client_query_results (${clientResult.id}) with no valid emails status`);
                    }
                }
            } else {
                console.log(`Row ${row.record_id}: No matching client_query_results found for URL: ${row.url}`);
            }
        }

        await supabase
            .from('email_scraper_node')
            .update({
                status: 'auto_final_completed',
                verified_emails: verifiedEmails,
                rejected_emails: rejectedEmails
            })
            .eq('id', row.record_id);

    } catch (error) {
        console.error(`Error processing row ${row.record_id}:`, error);
        stats.errors++;

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

export async function mainLoop() {
    let backoffMs = 1000;
    const maxBackoff = 60000;

    console.log(`Starting worker with max concurrency: ${MAX_CONCURRENCY} `);

    const { count: queuedCount, error: qErr } = await supabase
        .from('email_scraper_node')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'auto_completed')
        .eq('mode', 'auto');

    if (qErr) {
        console.error("Startup check failed.", qErr);
    } else {
        console.log(`Startup Status: completed=${queuedCount}`);
    }

    while (!isShuttingDown()) {
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

            await sleep(100);
        } catch (error) {
            console.error("Main loop error:", error);
            await sleep(5000);
        }
    }
}

export async function gracefulShutdown(signal: string) {
    console.log(`\nReceived ${signal}. Shutting down...`);
    setShuttingDown(true);
    console.log('Waiting for active jobs to complete...');
    await queue.onIdle();
    console.log('Goodbye.');
    process.exit(0);
}
