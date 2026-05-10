/**
 * @description: Shared helpers for SerpAPI request URL construction across context integrations.
 * @footnote-scope: utility
 * @footnote-module: SerpApiContextIntegrationHelpers
 * @footnote-risk: low - URL-shape bugs can misroute provider calls but stay bounded to context integrations.
 * @footnote-ethics: low - Affects external lookup routing, not policy authority decisions.
 */

type SerpApiSearchParamValue = string | number | boolean | null | undefined;

export const buildSerpApiSearchUrl = (
    params: Record<string, SerpApiSearchParamValue>
): string => {
    const endpoint = new URL('https://serpapi.com/search.json');
    for (const [key, value] of Object.entries(params)) {
        if (value === null || value === undefined) {
            continue;
        }
        const normalized =
            typeof value === 'string' ? value.trim() : String(value);
        if (normalized.length === 0) {
            continue;
        }
        endpoint.searchParams.set(key, normalized);
    }
    return endpoint.toString();
};
