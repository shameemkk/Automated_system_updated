/**
 * Worker utility functions for normalizing scraper responses.
 * Identical contract to http_request/worker-utils.ts — htmlparser returns the same shape.
 */

export interface NormalizedResult {
    status: 'auto_completed' | 'auto_error';
    emails: string[];
    facebook_urls: string[];
    message: string | null;
    needs_browser_rendering: boolean;
    partial: boolean;
}

export interface NormalizedItem {
    json: NormalizedResult;
}

export function normalizeResponse(items: { json: any }[]): NormalizedItem[] {
    return items.map(item => {
        const data = item.json;
        // js_rendered === false means HTTP scrape detected SPA / needs browser
        const needsBrowserRendering = data?.js_rendered === false;

        const partial = data?.partial === true;

        if (data?.success === true) {
            return {
                json: {
                    status: 'auto_completed' as const,
                    emails: Array.isArray(data.emails) ? data.emails : [],
                    facebook_urls: Array.isArray(data.facebook_urls) ? data.facebook_urls : [],
                    message: null,
                    needs_browser_rendering: needsBrowserRendering,
                    partial,
                },
            };
        }
        if (data?.error) {
            return {
                json: {
                    status: 'auto_error' as const,
                    emails: [],
                    facebook_urls: [],
                    message: data.message || data.error || 'Unknown error',
                    needs_browser_rendering: needsBrowserRendering,
                    partial,
                },
            };
        }
        return {
            json: {
                status: 'auto_error' as const,
                emails: [],
                facebook_urls: [],
                message: 'Invalid response format',
                needs_browser_rendering: false,
                partial: false,
            },
        };
    });
}
