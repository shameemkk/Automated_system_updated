import { supabase } from '../src/config.ts';

export interface ScraperRow {
    id: number;
    emails: string[] | null;
    url: string | null;
    automation_id: number;
    status: string;
    mode: string;
    verified_emails?: string[];
    rejected_emails?: Record<string, string>;
    updated_at?: string;
}

export interface ClientResultRow {
    id: number;
    website: string;
    automation_id: number;
    verified_emails: string[] | null;
    mode?: string;
    gpt_process?: string;
}

export const store: {
    scraperRows: ScraperRow[];
    clientResults: ClientResultRow[];
} = {
    scraperRows: [],
    clientResults: []
};

type Filter = { col: string; val: any };

function buildSelector(table: string) {
    const filters: Filter[] = [];
    let limitVal: number | null = null;
    let countMode: 'exact' | null = null;
    let headOnly = false;

    const rowsFor = (): any[] => {
        const all = table === 'email_scraper_node' ? store.scraperRows : store.clientResults;
        let filtered = all.filter(row => filters.every(f => (row as any)[f.col] === f.val));
        if (limitVal !== null) filtered = filtered.slice(0, limitVal);
        return filtered;
    };

    const result = (): { data: any; error: null; count?: number } => {
        const rows = rowsFor();
        const out: any = { data: headOnly ? null : rows, error: null };
        if (countMode === 'exact') out.count = rows.length;
        return out;
    };

    const builder: any = {
        select(_cols?: string, opts?: { count?: 'exact'; head?: boolean }) {
            if (opts?.count === 'exact') countMode = 'exact';
            if (opts?.head) headOnly = true;
            return builder;
        },
        eq(col: string, val: any) {
            filters.push({ col, val });
            return builder;
        },
        limit(n: number) {
            limitVal = n;
            return builder;
        },
        then(resolve: (v: any) => any, reject?: (e: any) => any) {
            try { return Promise.resolve(result()).then(resolve, reject); }
            catch (e) { return Promise.reject(e).then(resolve, reject); }
        }
    };

    return builder;
}

function buildUpdater(table: string, patch: Record<string, any>) {
    const filters: Filter[] = [];

    const apply = () => {
        const all = table === 'email_scraper_node' ? store.scraperRows : store.clientResults;
        const matched = all.filter(row => filters.every(f => (row as any)[f.col] === f.val));
        for (const row of matched) Object.assign(row, patch);
        return { data: null, error: null };
    };

    const updater: any = {
        eq(col: string, val: any) {
            filters.push({ col, val });
            return updater;
        },
        then(resolve: (v: any) => any, reject?: (e: any) => any) {
            try { return Promise.resolve(apply()).then(resolve, reject); }
            catch (e) { return Promise.reject(e).then(resolve, reject); }
        }
    };

    return updater;
}

export function installSupabaseStub(): void {
    (supabase as any).rpc = async (name: string, args: { batch_size: number }) => {
        if (name !== 'fetch_email_verification_records') {
            throw new Error(`Unsupported RPC in stub: ${name}`);
        }
        const batch = Math.max(0, args?.batch_size ?? 0);
        const claimable = store.scraperRows
            .filter(r => r.status === 'auto_completed' && Array.isArray(r.emails) && (r.emails?.length ?? 0) > 0)
            .slice(0, batch);
        for (const r of claimable) {
            r.status = 'e_v_processing';
            r.updated_at = new Date().toISOString();
        }
        const data = claimable.map(r => ({
            record_id: r.id,
            emails: r.emails,
            url: r.url,
            automation_id: r.automation_id
        }));
        return { data, error: null };
    };

    (supabase as any).from = (table: string) => {
        if (table !== 'email_scraper_node' && table !== 'client_query_results') {
            throw new Error(`Unsupported table in stub: ${table}`);
        }
        return {
            select: (cols?: string, opts?: { count?: 'exact'; head?: boolean }) =>
                buildSelector(table).select(cols, opts),
            update: (patch: Record<string, any>) => buildUpdater(table, patch),
            eq: (col: string, val: any) => buildSelector(table).eq(col, val)
        };
    };
}

export function dumpStore(): string {
    return JSON.stringify(store, null, 2);
}
