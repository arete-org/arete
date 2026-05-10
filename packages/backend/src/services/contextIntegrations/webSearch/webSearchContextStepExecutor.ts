/**
 * @description: Web-search context-step executor with provider-neutral fallback across SearXNG, Brave, and SerpAPI.
 * @footnote-scope: core
 * @footnote-module: WebSearchContextStepExecutor
 * @footnote-risk: medium - Search-provider failures can affect grounding quality if not mapped consistently.
 * @footnote-ethics: medium - Search output labeling must avoid overstating source confidence.
 */
import type {
    Citation,
    ToolInvocationReasonCode,
} from '@footnote/contracts/policy';
import {
    buildExecutedContextStepResult,
    buildFailedContextStepResult,
    buildSkippedContextStepResult,
} from '../contextStepExecution.js';
import { buildSerpApiSearchUrl } from '../shared/serpApi.js';
import type {
    ContextStepExecutor,
    ContextStepResult,
} from '../../workflowEngine.js';

export type WebSearchProviderName = 'searxng' | 'brave' | 'serpapi';

type WebSearchInput = {
    query: string;
    intent?: 'repo_explainer' | 'current_facts';
    contextSize?: 'low' | 'medium' | 'high';
    repoHints?: string[];
    topicHints?: string[];
};

type WebSearchRecord = {
    title: string;
    url: string;
    snippet?: string;
    provider: WebSearchProviderName;
};

export type WebSearchHint = {
    query: string;
    intent: 'repo_explainer' | 'current_facts';
    priority: 'low' | 'medium' | 'high';
    reason?: string;
};

export type WebSearchProviderAttempt = {
    provider: WebSearchProviderName;
    status: 'executed_with_results' | 'executed_empty' | 'skipped' | 'failed';
    reasonCode?: ToolInvocationReasonCode;
    durationMs: number;
    resultCount: number;
};

export type WebSearchContextStepIntegrationPayload = {
    attempts: WebSearchProviderAttempt[];
    searchHints: WebSearchHint[];
};

type WebSearchProviderResult =
    | { ok: true; records: WebSearchRecord[] }
    | { ok: false; reasonCode: ToolInvocationReasonCode };

type WebSearchProviderAttemptStatus = WebSearchProviderAttempt['status'];

type WebSearchProviderExecutorInput = {
    query: string;
    timeoutMs: number;
    maxResults: number;
};

type WebSearchProviderRegistryEntry = {
    isConfigured: () => boolean;
    run: (
        input: WebSearchProviderExecutorInput
    ) => Promise<WebSearchProviderResult>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const parseWebSearchInput = (input: unknown): WebSearchInput | undefined => {
    if (!isRecord(input) || typeof input.query !== 'string') {
        return undefined;
    }
    const query = input.query.trim();
    if (query.length === 0) {
        return undefined;
    }
    return {
        query,
        intent:
            input.intent === 'repo_explainer' ||
            input.intent === 'current_facts'
                ? input.intent
                : 'current_facts',
        contextSize:
            input.contextSize === 'low' ||
            input.contextSize === 'medium' ||
            input.contextSize === 'high'
                ? input.contextSize
                : 'medium',
        repoHints: Array.isArray(input.repoHints)
            ? input.repoHints.filter((v): v is string => typeof v === 'string')
            : undefined,
        topicHints: Array.isArray(input.topicHints)
            ? input.topicHints.filter((v): v is string => typeof v === 'string')
            : undefined,
    };
};

const normalizeUrl = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return undefined;
        }
        return parsed.toString();
    } catch {
        return undefined;
    }
};

const normalizeCitation = (record: WebSearchRecord): Citation => ({
    title: record.title.trim().length > 0 ? record.title.trim() : 'Source',
    url: record.url,
    ...(record.snippet && record.snippet.trim().length > 0
        ? { snippet: record.snippet.trim() }
        : {}),
});

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
        for (const entry of json.results ?? []) {
            if (!isRecord(entry)) {
                continue;
            }
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

const formatContextMessages = (
    query: string,
    records: WebSearchRecord[]
): string[] => {
    if (records.length === 0) {
        return [];
    }
    const sanitizeUntrustedText = (value: string): string =>
        Array.from(value)
            .map((char) => {
                const code = char.charCodeAt(0);
                return code < 32 || code === 127 ? ' ' : char;
            })
            .join('')
            .replace(/\s+/g, ' ')
            .trim();
    const lines = records.map((record, index) => {
        const title = sanitizeUntrustedText(record.title);
        const snippet =
            typeof record.snippet === 'string'
                ? sanitizeUntrustedText(record.snippet)
                : undefined;
        return snippet && snippet.length > 0
            ? `${index + 1}. UNTRUSTED SEARCH RESULT: ${title} (${record.url}) - ${snippet}`
            : `${index + 1}. UNTRUSTED SEARCH RESULT: ${title} (${record.url})`;
    });
    return [`Web search results for "${query}":`, ...lines];
};

const buildSearchHints = (input: WebSearchInput): WebSearchHint[] => {
    const hints: WebSearchHint[] = [];
    const topicHints = input.topicHints ?? [];
    for (const topic of topicHints) {
        const trimmed = topic.trim();
        if (trimmed.length === 0) {
            continue;
        }
        hints.push({
            query: `${input.query} ${trimmed}`.trim(),
            intent: input.intent ?? 'current_facts',
            priority: 'medium',
            reason: 'topic_hint_refinement',
        });
    }
    if (input.intent === 'repo_explainer') {
        hints.push({
            query: `${input.query} ${[...(input.repoHints ?? [])].join(' ')}`.trim(),
            intent: 'repo_explainer',
            priority: 'high',
            reason: 'repo_explainer_deepening',
        });
    }
    return hints.slice(0, 3);
};

const createAttemptRecorder = (attempts: WebSearchProviderAttempt[]) => ({
    push: (input: {
        provider: WebSearchProviderName;
        status: WebSearchProviderAttemptStatus;
        durationMs: number;
        resultCount: number;
        reasonCode?: ToolInvocationReasonCode;
    }): void => {
        attempts.push({
            provider: input.provider,
            status: input.status,
            ...(input.reasonCode !== undefined && {
                reasonCode: input.reasonCode,
            }),
            durationMs: input.durationMs,
            resultCount: input.resultCount,
        });
    },
    skipped: (provider: WebSearchProviderName): void => {
        attempts.push({
            provider,
            status: 'skipped',
            reasonCode: 'tool_unavailable',
            durationMs: 0,
            resultCount: 0,
        });
    },
    failed: (
        provider: WebSearchProviderName,
        reasonCode: ToolInvocationReasonCode,
        durationMs: number
    ): void => {
        attempts.push({
            provider,
            status: 'failed',
            reasonCode,
            durationMs,
            resultCount: 0,
        });
    },
    completed: (
        provider: WebSearchProviderName,
        records: WebSearchRecord[],
        durationMs: number
    ): void => {
        attempts.push({
            provider,
            status:
                records.length > 0 ? 'executed_with_results' : 'executed_empty',
            durationMs,
            resultCount: records.length,
        });
    },
});

export const createWebSearchContextStepExecutor = ({
    enabled,
    providerPriority,
    searxngBaseUrl,
    braveApiKey,
    serpApiKey,
    serpApiEngine,
    serpApiGl,
    serpApiHl,
    providerTimeoutMs,
    maxResults,
    onWarn,
}: {
    enabled: boolean;
    providerPriority: WebSearchProviderName[];
    searxngBaseUrl: string | null;
    braveApiKey: string | null;
    serpApiKey: string | null;
    serpApiEngine: string | null;
    serpApiGl: string | null;
    serpApiHl: string | null;
    providerTimeoutMs: number;
    maxResults: number;
    onWarn?: (message: string, meta?: Record<string, unknown>) => void;
}): ContextStepExecutor => {
    const warn = onWarn ?? (() => undefined);
    return async ({ request }): Promise<ContextStepResult> => {
        if (!enabled) {
            return buildSkippedContextStepResult({
                toolName: request.integrationName,
                reasonCode: 'tool_unavailable',
            });
        }
        if (!request.requested) {
            return buildSkippedContextStepResult({
                toolName: request.integrationName,
                reasonCode: request.reasonCode ?? 'tool_not_requested',
            });
        }
        if (!request.eligible) {
            return buildSkippedContextStepResult({
                toolName: request.integrationName,
                reasonCode: request.reasonCode ?? 'unspecified_tool_outcome',
            });
        }
        const input = parseWebSearchInput(request.input);
        if (!input) {
            return buildFailedContextStepResult({
                toolName: request.integrationName,
                reasonCode: 'unspecified_tool_outcome',
            });
        }

        const attempts: WebSearchProviderAttempt[] = [];
        const attemptRecorder = createAttemptRecorder(attempts);
        const startedAt = Date.now();
        let discovered: WebSearchRecord[] = [];
        const providerRegistry: Record<
            WebSearchProviderName,
            WebSearchProviderRegistryEntry
        > = {
            searxng: {
                isConfigured: () => Boolean(searxngBaseUrl),
                run: async ({ query, timeoutMs, maxResults }) =>
                    runSearxng({
                        baseUrl: searxngBaseUrl as string,
                        query,
                        timeoutMs,
                        maxResults,
                    }),
            },
            brave: {
                isConfigured: () => Boolean(braveApiKey),
                run: async ({ query, timeoutMs, maxResults }) =>
                    runBrave({
                        apiKey: braveApiKey as string,
                        query,
                        timeoutMs,
                        maxResults,
                    }),
            },
            serpapi: {
                isConfigured: () => Boolean(serpApiKey),
                run: async ({ query, timeoutMs, maxResults }) =>
                    runSerpApi({
                        apiKey: serpApiKey as string,
                        query,
                        engine: serpApiEngine,
                        gl: serpApiGl,
                        hl: serpApiHl,
                        timeoutMs,
                        maxResults,
                    }),
            },
        };
        for (const provider of providerPriority) {
            const providerStartedAt = Date.now();
            const registryEntry = providerRegistry[provider];
            if (!registryEntry) {
                attemptRecorder.push({
                    provider,
                    status: 'skipped',
                    reasonCode: 'tool_unavailable',
                    durationMs: 0,
                    resultCount: 0,
                });
                continue;
            }
            if (!registryEntry.isConfigured()) {
                attemptRecorder.skipped(provider);
                continue;
            }
            const result = await registryEntry.run({
                query: input.query,
                timeoutMs: providerTimeoutMs,
                maxResults,
            });
            const durationMs = Math.max(0, Date.now() - providerStartedAt);
            if (!result.ok) {
                attemptRecorder.failed(provider, result.reasonCode, durationMs);
                continue;
            }
            attemptRecorder.completed(provider, result.records, durationMs);
            if (result.records.length > 0) {
                discovered = result.records;
                break;
            }
        }

        const durationMs = Math.max(0, Date.now() - startedAt);
        const searchHints = buildSearchHints(input);
        if (discovered.length === 0) {
            warn('web_search context integration completed without results', {
                attempts,
                query: input.query,
            });
            if (attempts.every((attempt) => attempt.status === 'skipped')) {
                return {
                    executionContext: {
                        toolName: request.integrationName,
                        status: 'skipped',
                        reasonCode: 'tool_unavailable',
                        durationMs,
                    },
                    integrationContext: {
                        kind: 'web_search',
                        version: 'v1',
                        payload: {
                            attempts,
                            searchHints,
                        } satisfies WebSearchContextStepIntegrationPayload,
                    },
                };
            }
            if (attempts.some((attempt) => attempt.status === 'failed')) {
                return buildFailedContextStepResult({
                    toolName: request.integrationName,
                    reasonCode: 'tool_execution_error',
                    durationMs,
                    integrationContext: {
                        kind: 'web_search',
                        version: 'v1',
                        payload: {
                            attempts,
                            searchHints,
                        } satisfies WebSearchContextStepIntegrationPayload,
                    },
                });
            }
            return {
                executionContext: {
                    toolName: request.integrationName,
                    status: 'skipped',
                    reasonCode: 'tool_not_used',
                    durationMs,
                },
                integrationContext: {
                    kind: 'web_search',
                    version: 'v1',
                    payload: {
                        attempts,
                        searchHints,
                    } satisfies WebSearchContextStepIntegrationPayload,
                },
            };
        }

        return buildExecutedContextStepResult({
            toolName: request.integrationName,
            durationMs,
            contextMessages: formatContextMessages(input.query, discovered),
            sources: discovered.map(normalizeCitation),
            integrationContext: {
                kind: 'web_search',
                version: 'v1',
                payload: {
                    attempts,
                    searchHints,
                } satisfies WebSearchContextStepIntegrationPayload,
            },
        });
    };
};
