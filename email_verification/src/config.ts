import { createClient } from '@supabase/supabase-js';
import PQueue from 'p-queue';
import * as dotenv from 'dotenv';

dotenv.config();

export const SUPABASE_URL = process.env.SUPABASE_URL || '';
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
export const MILLION_VERIFIER_API_KEY = process.env.MILLION_VERIFIER_API_KEY || '';
export const TRYKITT_API_KEY = process.env.TRYKITT_API_KEY || '';

export const MAX_CONCURRENCY = 150; // Rate limit: 6 req/sec
export const EXTERNAL_API_TIMEOUT = 300000;

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

export const FREE_EMAIL_DOMAINS = ["gmail.com", "yahoo.com", "ymail.com", "zoho.com", "proton.me", "protonmail.com", "icloud.com", "me.com", "mac.com"];
export const MICROSOFT_ESP_DOMAINS = ["outlook.com", "office365.com", "hotmail.com", "microsoft"];

export const PRIORITY_KEYWORDS = /facility|facilities|facilitiesmanager|facilitymanager|fm|buildingmanager|propertymanager|maintenance|maint|repairs|janitorial|janitor|custodian|upkeep|operations|ops|operationmanager|facilityservices|operationsmanager|buildingops|operationslead|siteoperations|sitelead|sitecoordinator|plantmanager|plantops|plantmaintenance|buildingservices|buildingmaintenance|facilityservices|property|propertymanagement|realestate|estate|estates|premises|premisesmanager|propertycare|buildingcare|cleaning|custodial|sanitation|cleaner|maintenancecrew|maintenanceoffice|owner|founder|cofounder|partner|co-owner|boss|director|managingdirector|managingpartner|md|principal|proprietor/i;

export const stats = {
    processed: 0,
    errors: 0,
    active: 0
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

export const queue = new PQueue({ concurrency: MAX_CONCURRENCY });

let shuttingDown = false;

export const isShuttingDown = () => shuttingDown;
export const setShuttingDown = (value: boolean) => { shuttingDown = value; };
