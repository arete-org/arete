/**
 * @description: Provider adapters and registry wiring for web-search context integration.
 * @footnote-scope: core
 * @footnote-module: WebSearchProviders
 * @footnote-risk: medium - Provider adapter regressions can break fallback behavior.
 * @footnote-ethics: medium - Provider output mapping affects user-visible grounding quality.
 */
import { buildSerpApiSearchUrl } from '../shared/serpApi.js';
import { normalizeUrl } from './webSearchNormalization.js';
import type {
    WebSearchProviderName,
    WebSearchProviderResult,
    WebSearchRecord,
} from './webSearchTypes.js';

const withTimeout = async (
    url: string,
    init: Parameters<typeof fetch>[1],
    timeoutMs: number
): Promise<Response> => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeoutHandle);
    }
};

const runSearxng = async ({
    baseUrl: rawBaseUrl,
    query,
    timeoutMs,
    maxResults,
}: {
    baseUrl: string;
    query: string;
    timeoutMs: number;
    maxResults: number;
}): Promise<WebSearchProviderResult> => {
    const baseUrl = rawBaseUrl.endsWith('/') ? rawBaseUrl : `${rawBaseUrl}/`;
    const endpoint = new URL('search', baseUrl);
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('format', 'json');
    try {
        const response = await withTimeout(
            endpoint.toString(),
            { method: 'GET' },
            timeoutMs
        );
        if (!response.ok) {
            return { ok: false, reasonCode: 'tool_http_error' };
        }
        const json = (await response.json()) as { results?: unknown[] };
        const records: WebSearchRecord[] = [];
        for (const rawEntry of json.results ?? []) {
            if (
                typeof rawEntry !== 'object' ||
                rawEntry === null ||
                Array.isArray(rawEntry)
            ) {
                continue;
            }
            const entry = rawEntry as Record<string, unknown>;
            const url = normalizeUrl(entry.url);
            if (!url) {
                continue;
            }
            records.push({
                title: typeof entry.title === 'string' ? entry.title : 'Source',
                url,
                snippet:
                    typeof entry.content === 'string'
                        ? entry.content
                        : undefined,
                provider: 'searxng',
            });
            if (records.length >= maxResults) {
                break;
            }
        }
        return { ok: true, records };
    } catch (error) {
        const reasonCode =
            error instanceof Error && error.name === 'AbortError'
                ? 'tool_timeout'
                : 'tool_network_error';
        return { ok: false, reasonCode };
    }
};

const runBrave = async ({
    apiKey,
    query,
    timeoutMs,
    maxResults,
}: {
    apiKey: string;
    query: string;
    timeoutMs: number;
    maxResults: number;
}): Promise<WebSearchProviderResult> => {
    const endpoint = new URL('https://api.search.brave.com/res/v1/web/search');
    endpoint.searchParams.set('q', query);
    try {
        const response = await withTimeout(
            endpoint.toString(),
            {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    'X-Subscription-Token': apiKey,
                },
            },
            timeoutMs
        );
        if (!response.ok) {
            return { ok: false, reasonCode: 'tool_http_error' };
        }
        const json = (await response.json()) as {
            web?: { results?: Array<Record<string, unknown>> };
        };
        const records: WebSearchRecord[] = [];
        for (const entry of json.web?.results ?? []) {
            const url = normalizeUrl(entry.url);
            if (!url) {
                continue;
            }
            records.push({
                title: typeof entry.title === 'string' ? entry.title : 'Source',
                url,
                snippet:
                    typeof entry.description === 'string'
                        ? entry.description
                        : undefined,
                provider: 'brave',
            });
            if (records.length >= maxResults) {
                break;
            }
        }
        return { ok: true, records };
    } catch (error) {
        const reasonCode =
            error instanceof Error && error.name === 'AbortError'
                ? 'tool_timeout'
                : 'tool_network_error';
        return { ok: false, reasonCode };
    }
};

const runSerpApi = async ({
    apiKey,
    query,
    engine,
    gl,
    hl,
    timeoutMs,
    maxResults,
}: {
    apiKey: string;
    query: string;
    engine: string | null;
    gl: string | null;
    hl: string | null;
    timeoutMs: number;
    maxResults: number;
}): Promise<WebSearchProviderResult> => {
    const endpoint = buildSerpApiSearchUrl({
        q: query,
        api_key: apiKey,
        engine: engine ?? 'google',
        gl,
        hl,
    });
    try {
        const response = await withTimeout(
            endpoint,
            { method: 'GET' },
            timeoutMs
        );
        if (!response.ok) {
            return { ok: false, reasonCode: 'tool_http_error' };
        }
        const json = (await response.json()) as {
            organic_results?: Array<Record<string, unknown>>;
        };
        const records: WebSearchRecord[] = [];
        for (const entry of json.organic_results ?? []) {
            const url = normalizeUrl(entry.link);
            if (!url) {
                continue;
            }
            records.push({
                title: typeof entry.title === 'string' ? entry.title : 'Source',
                url,
                snippet:
                    typeof entry.snippet === 'string'
                        ? entry.snippet
                        : undefined,
                provider: 'serpapi',
            });
            if (records.length >= maxResults) {
                break;
            }
        }
        return { ok: true, records };
    } catch (error) {
        const reasonCode =
            error instanceof Error && error.name === 'AbortError'
                ? 'tool_timeout'
                : 'tool_network_error';
        return { ok: false, reasonCode };
    }
};

export type WebSearchProviderRegistryEntry = {
    isConfigured: () => boolean;
    run: (input: {
        query: string;
        timeoutMs: number;
        maxResults: number;
    }) => Promise<WebSearchProviderResult>;
};

export const buildWebSearchProviderRegistry = (input: {
    searxngBaseUrl: string | null;
    braveApiKey: string | null;
    serpApiKey: string | null;
    serpApiEngine: string | null;
    serpApiGl: string | null;
    serpApiHl: string | null;
}): Record<WebSearchProviderName, WebSearchProviderRegistryEntry> => ({
    searxng: {
        isConfigured: () => Boolean(input.searxngBaseUrl),
        run: async ({ query, timeoutMs, maxResults }) =>
            runSearxng({
                baseUrl: input.searxngBaseUrl as string,
                query,
                timeoutMs,
                maxResults,
            }),
    },
    brave: {
        isConfigured: () => Boolean(input.braveApiKey),
        run: async ({ query, timeoutMs, maxResults }) =>
            runBrave({
                apiKey: input.braveApiKey as string,
                query,
                timeoutMs,
                maxResults,
            }),
    },
    serpapi: {
        isConfigured: () => Boolean(input.serpApiKey),
        run: async ({ query, timeoutMs, maxResults }) =>
            runSerpApi({
                apiKey: input.serpApiKey as string,
                query,
                engine: input.serpApiEngine,
                gl: input.serpApiGl,
                hl: input.serpApiHl,
                timeoutMs,
                maxResults,
            }),
    },
});
