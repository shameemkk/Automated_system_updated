import { MICROSOFT_ESP_DOMAINS, PRIORITY_KEYWORDS } from './config.ts';

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function isMicrosoftESP(data: any): boolean {
    const dataStr = (JSON.stringify(data) || '').toLowerCase();
    return MICROSOFT_ESP_DOMAINS.some(s => dataStr.includes(s));
}

export function dedupeEmails(emails: string[]): string[] {
    return [...new Set((emails || []).map((e: string) => e.toLowerCase()))];
}

export function prioritizeAndLimitEmails(emails: string[]): string[] {
    return emails
        .filter(Boolean)
        .sort((a, b) => {
            const aMatch = PRIORITY_KEYWORDS.test(a) ? 1 : 0;
            const bMatch = PRIORITY_KEYWORDS.test(b) ? 1 : 0;
            return bMatch - aMatch;
        })
        .slice(0, 5);
}

export function getAllUniqueDomainsFromEmails(emails: string[]): string[] {
    if (!emails || emails.length === 0) return [];
    const domains = emails
        .map(email => email.split('@')[1]?.toLowerCase())
        .filter((d): d is string => !!d);
    return [...new Set(domains)];
}
