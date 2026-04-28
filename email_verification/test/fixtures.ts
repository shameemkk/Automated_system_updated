import type { ScraperRow, ClientResultRow } from './supabase-stub.ts';

// NOTE: The addresses below hit the real Million Verifier and TryKitt APIs.
// Replace them with addresses you actually want to verify before running, or
// keep them as-is to see how the providers respond to common patterns.

export const seedScraperRows: ScraperRow[] = [
    {
        id: 1,
        emails: ['someone@gmail.com', 'owner@example.com'],
        url: 'https://example.com',
        automation_id: 100,
        status: 'auto_completed',
        mode: 'auto'
    },
    {
        id: 2,
        emails: ['hello@example.com'],
        url: 'https://example.com',
        automation_id: 101,
        status: 'auto_completed',
        mode: 'auto'
    },
    {
        id: 3,
        emails: ['not-a-real-mailbox-xyz123@example.com'],
        url: 'https://example.com',
        automation_id: 102,
        status: 'auto_completed',
        mode: 'auto'
    },
    {
        id: 4,
        emails: ['someone@outlook.com'],
        url: 'https://outlook-test.com',
        automation_id: 103,
        status: 'auto_completed',
        mode: 'auto'
    },
    {
        id: 5,
        emails: ['contact@unmatched-url.com'],
        url: 'https://unmatched-url.com',
        automation_id: 999,
        status: 'auto_completed',
        mode: 'auto'
    },
    {
        id: 6,
        emails: [],
        url: 'https://empty-emails.com',
        automation_id: 105,
        status: 'auto_completed',
        mode: 'auto'
    },
    {
        id: 7,
        emails: [
            'sales@priority-test.com',
            'info@priority-test.com',
            'support@priority-test.com',
            'noreply@priority-test.com',
            'admin@priority-test.com',
            'hr@priority-test.com',
            'owner@priority-test.com',
            'facility@priority-test.com'
        ],
        url: 'https://priority-test.com',
        automation_id: 106,
        status: 'auto_completed',
        mode: 'auto'
    }
];

export const seedClientResults: ClientResultRow[] = [
    {
        id: 1001,
        website: 'https://example.com',
        automation_id: 100,
        verified_emails: ['existing@example.com']
    },
    {
        id: 1002,
        website: 'https://example.com',
        automation_id: 101,
        verified_emails: null
    },
    {
        id: 1003,
        website: 'https://example.com',
        automation_id: 102,
        verified_emails: null
    },
    {
        id: 1004,
        website: 'https://outlook-test.com',
        automation_id: 103,
        verified_emails: null
    },
    {
        id: 1006,
        website: 'https://empty-emails.com',
        automation_id: 105,
        verified_emails: null
    },
    {
        id: 1007,
        website: 'https://priority-test.com',
        automation_id: 106,
        verified_emails: null
    }
];
