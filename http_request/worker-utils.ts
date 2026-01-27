/**
 * Worker utility functions for normalizing scraper responses
 */

export interface NormalizedResult {
    status: 'auto_completed' | 'auto_error';
    emails: string[];
    facebook_urls: string[];
    message: string | null;
    needs_browser_rendering: boolean;
}

export interface NormalizedItem {
    json: NormalizedResult;
}

/**
 * Normalizes scraper responses into a consistent format for database updates
 * @param items - Array of items with json property containing scraper response
 * @returns Array of normalized items with consistent structure
 */
export function normalizeResponse(items: { json: any }[]): NormalizedItem[] {
    return items.map(item => {
        const data = item.json;
        // js_rendered === false means HTTP failed and site needs browser rendering
        const needsBrowserRendering = data.js_rendered === false;
        
        if (data.success === true) {
            return {
                json: {
                    status: "auto_completed" as const,
                    emails: Array.isArray(data.emails) ? data.emails : [],
                    facebook_urls: Array.isArray(data.facebook_urls) ? data.facebook_urls : [],
                    message: null,
                    needs_browser_rendering: needsBrowserRendering
                }
            };
        }
        if (data.error) {
            return {
                json: {
                    status: "auto_error" as const,
                    emails: [],
                    facebook_urls: [],
                    message: data.error.message || "Unknown error",
                    needs_browser_rendering: needsBrowserRendering
                }
            };
        }
        return {
            json: {
                status: "auto_error" as const,
                emails: [],
                facebook_urls: [],
                message: "Invalid response format",
                needs_browser_rendering: false
            }
        };
    });
}
