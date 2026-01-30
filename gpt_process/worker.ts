import { createClient } from '@supabase/supabase-js';
import PQueue from 'p-queue';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DEBUG = process.env.DEBUG === 'true';

const MAX_CONCURRENCY = 150;
const EXTERNAL_API_TIMEOUT = 300000;

// Debug logger - only logs when DEBUG is true
const debugLog = (...args: any[]) => {
    if (DEBUG) {
        console.log(...args);
    }
};

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
    process.exit(1);
}

if (!OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in .env');
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

// Normalize company name using ChatGPT API
async function normalizeCompanyName(name: string, website: string): Promise<string> {
    const prompt = `Objective: Normalize the provided Company Name by eliminating any extraneous words, phrases, or contexts while adhering strictly to the information given in both the Company Name and Company Domain.Instructions:* Primary Reference: Utilize the Company Name in conjunction with the Website Domain. Remove any words from the Company Name not reinforced by the Website Domain, ensuring the result is accurate and concise.* Acronyms and Abbreviations: When an acronym or abbreviation is commonly recognized and supported by the domain, use it as the output. (e.g., an input of 'American Council of Learned Societies (ACLS)' should output as 'ACLS'. An input of 'AUI™ (Augmented Intelligence)' should output as 'AUI'.* Unnecessary Words: Exclude words considered non-essential for identification (e.g., an input of 'Miami Dolphins and Hard Rock Stadium', should output as 'Miami Dolphins').* Compound Names: For names with hyphens or other separators that are vital for the brand's identity, leave these in the output.* Numericals in Names: When numbers or numericals are integral to the company's identity but vary from the domain, leave these in the output as they are (e.g., an input of '5.11 Tactical', should output as '5.11 Tactical'. An input of 'FourToEight' should output as 'FourToEight').* Word Limit: If the Company Name is multi-worded, retain only the first 1-3 words based on [criteria: recognizability, domain presence, etc.]. Restrict output to a maximum of 3 words; the shorter the output without compromising on accuracy, the better.* Legal Entity Suffixes: Strip away suffixes like 'LLC', 'Inc.', 'Corp.', 'DBA.' Etc. Also strip away any sort of special characters such as '™', '©', '®', or any emojis.* Descriptive Phrases: Remove any phrases following commas that describe status or affiliations, such as 'formerly known as', without adding hyphens or altering the core name's formatting. (e.g., an input of '1847Financial - Kane', should output as '1847Financial').* Capitalization: If any provided company names are given in all capital letters, format the capitalization so that the first letter of the word(s) is capitalized and the rest are lowercase. (e.g., an input of '360 DESIGN' should output as '360 Design'.) If the output is an abbreviation, leave all letters capitalized (e.g. input of 'USTA' should output as 'USTA'). For unique cases where the company name has unique capitalizations, leave the capitalization as-is (e.g. an input of 'BoohooMAN' should output as 'BoohooMAN').* Special Characters: Any instances of special characters such as '|', '-' with spacing or text after these characters should be stripped, UNLESS critical to the company name (e.g., An input of 'A&W' should output as 'A&W'. An input of 'Andrew Davidson & Co.' should output as 'Andrew Davidson'. An input of 'Alera Group | Relph Benefit Advisors' should output as 'Alera Group').Exception Handling:* Ambiguities: In cases where the website domain and company name suggest different core identifiers, focus on the provided company name instead of the provided website domain. Output: Present the cleaned Company Name, ensuring it is a singular, recognizable form of the company's identity. Provide only one variation of the output without any indicators or explanations. Do not output any punctuation that isn't found in the company name at the end (e.g., do not add a '.' at the end of the output).Note: Double-check your work for accuracy and ensure adherence to all the guidelines provided.Company Name: ${name}Company Domain: ${website}`;

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ],
            max_tokens: 100,
            temperature: 0.1
        }, {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: EXTERNAL_API_TIMEOUT
        });

        const normalizedName = response.data.choices[0]?.message?.content?.trim() || name;
        debugLog(`Normalized "${name}" -> "${normalizedName}"`);
        return normalizedName;
    } catch (error: any) {
        console.error(`Error normalizing company name "${name}":`, {
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            message: error.message
        });
        throw error;
    }
}

// Get plural category from business types using ChatGPT API
async function getPluralCategory(types: string): Promise<string> {
    const prompt = `Read ${types}. These are some Google Business categories of a company. Understand what business is this. Once you identified, give me the common business category we call them. Make the output lowercase letters and should be in plural form. Don't use / or - in the output, only one business category. Don't give explanation, or anything extra. Only output the plural form.`;

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ],
            max_tokens: 50,
            temperature: 0.1
        }, {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: EXTERNAL_API_TIMEOUT
        });

        const pluralCategory = response.data.choices[0]?.message?.content?.trim() || '';
        debugLog(`Plural category for "${types}" -> "${pluralCategory}"`);
        return pluralCategory;
    } catch (error: any) {
        console.error(`Error getting plural category for "${types}":`, {
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            message: error.message
        });
        throw error;
    }
}

// --- CORE WORKER LOGIC ---

async function processClientRow(row: any) {
    stats.active++;

    let normalizedName = row.normalized_name;
    let pluralCategory = '';

    try {
        debugLog(`Processing client row: ${row.name} - ${row.website}`);

        // Step 1: Normalize company name (skip if already exists)
        if (!normalizedName) {
            normalizedName = await normalizeCompanyName(row.name, row.website);
            debugLog(`Normalized name: ${normalizedName}`);

            // Save normalized name immediately
            await supabase
                .from('client_query_results')
                .update({ normalized_name: normalizedName })
                .eq('id', row.id);
        } else {
            debugLog(`Normalized name already exists: ${normalizedName}`);
        }

        // Step 2: Get plural category
        if (row.types) {
            pluralCategory = await getPluralCategory(row.types);
            debugLog(`Plural category: ${pluralCategory}`);
        }

        // Mark as completed and save both results
        await supabase
            .from('client_query_results')
            .update({ 
                gpt_process: 'auto_completed',
                normalized_name: normalizedName,
                plural_category: pluralCategory
            })
            .eq('id', row.id);

    } catch (error) {
        console.error(`Error processing client row ${row.name}:`, error);
        
        // Mark as error and save error message in gpt_process_message
        const errorMessage = error instanceof Error ? error.message : String(error);
        const updateData: any = { 
            gpt_process: 'error',
            gpt_process_message: errorMessage
        };
        
        // If we have normalized_name from step 1, save it even on error
        if (normalizedName) {
            updateData.normalized_name = normalizedName;
        }
        
        await supabase
            .from('client_query_results')
            .update(updateData)
            .eq('id', row.id);
            
        stats.errors++;
    } finally {
        stats.active--;
        stats.processed++;
        debugLog(`Finished processing ${row.name}. Processed: ${stats.processed}, Errors: ${stats.errors}`);
    }
}

async function fetchAndClaimClientRecords(slots: number, includeErrors: boolean = false): Promise<any[]> {
    if (slots <= 0) return [];

    // First try to get queued records
    let query = supabase
        .from('client_query_results')
        .update({ gpt_process: 'processing' })
        .eq('gpt_process', 'queued')
        .order('id')
        .select('id, name, website, types, normalized_name')
        .limit(slots);

    let { data, error } = await query;

    if (error) {
        console.error('Error claiming client query results:', error);
        return [];
    }

    // If no queued records and includeErrors is true, try to get error records
    if ((!data || data.length === 0) && includeErrors) {
        debugLog('No queued records found. Checking for error records to retry...');
        const errorQuery = supabase
            .from('client_query_results')
            .update({ gpt_process: 'processing' })
            .eq('gpt_process', 'error')
            .order('id')
            .select('id, name, website, types, normalized_name')
            .limit(slots);

        const errorResult = await errorQuery;
        if (errorResult.error) {
            console.error('Error claiming error records:', errorResult.error);
            return [];
        }
        data = errorResult.data;
        if (data && data.length > 0) {
            debugLog(`Found ${data.length} error records to retry.`);
        }
    }

    return data || [];
}

async function mainLoop() {
    let backoffMs = 1000;
    const maxBackoff = 60000;

    console.log(`Starting worker with max concurrency: ${MAX_CONCURRENCY}`);

    while (!shuttingDown) {
        try {
            const currentPending = queue.pending;
            const slotsAvailable = MAX_CONCURRENCY - currentPending;

            if (slotsAvailable > 0) {
                // First try queued records, if none found, try error records
                const clientJobs = await fetchAndClaimClientRecords(slotsAvailable, true);

                if (clientJobs.length > 0) {
                    backoffMs = 1000;
                    console.log(`Claimed and processing ${clientJobs.length} client records.`);
                    clientJobs.forEach(row => {
                        queue.add(() => processClientRow(row));
                    });
                } else {
                    console.log(`No client records to process. Waiting ${backoffMs}ms...`);
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