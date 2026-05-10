/**
 * @description: Verifies web-search context-step execution behavior across provider fallback and fail-open semantics.
 * @footnote-scope: test
 * @footnote-module: WebSearchContextStepExecutorTests
 * @footnote-risk: medium - Regressions can silently misclassify search execution and grounding sources.
 * @footnote-ethics: medium - Search metadata quality affects transparency and reviewability.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebSearchContextStepExecutor } from '../src/services/contextIntegrations/webSearch/index.js';

const createBaseInput = () => ({
    workflowId: 'wf_test',
    workflowName: 'test',
    attempt: 1,
    request: {
        integrationName: 'web_search',
        requested: true,
        eligible: true,
        input: {
            query: 'latest OpenAI policy update',
            intent: 'current_facts',
            contextSize: 'low',
            topicHints: ['policy'],
        },
    },
});

test('web search executor returns executed with normalized citations from searxng', async () => {
    const originalFetch = globalThis.fetch;
    let observedUrl = '';
    globalThis.fetch = async (url) => {
        observedUrl = String(url);
        return {
            ok: true,
            json: async () => ({
                results: [
                    {
                        title: 'OpenAI policy update',
                        url: 'https://example.com/policy',
                        content: 'Policy summary',
                    },
                ],
            }),
        } as Response;
    };
    try {
        const executor = createWebSearchContextStepExecutor({
            enabled: true,
            providerPriority: ['searxng', 'brave'],
            searxngBaseUrl: 'https://searxng.example/custom/base',
            braveApiKey: null,
            serpApiKey: null,
            serpApiEngine: null,
            serpApiGl: null,
            serpApiHl: null,
            providerTimeoutMs: 1000,
            maxResults: 4,
        });
        const result = await executor(createBaseInput());
        assert.equal(result.executionContext.status, 'executed');
        assert.equal(result.sources?.[0]?.url, 'https://example.com/policy');
        assert.ok(
            result.contextMessages?.some((line) => line.includes('OpenAI'))
        );
        assert.ok(observedUrl.includes('/custom/base/search'));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('web search executor falls back to brave when searxng fails', async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
        callCount += 1;
        if (callCount === 1) {
            throw new Error('network fail');
        }
        return {
            ok: true,
            json: async () => ({
                web: {
                    results: [
                        {
                            title: 'Brave result',
                            url: 'https://brave.example/result',
                            description: 'Brave fallback worked',
                        },
                    ],
                },
            }),
        } as Response;
    };
    try {
        const executor = createWebSearchContextStepExecutor({
            enabled: true,
            providerPriority: ['searxng', 'brave'],
            searxngBaseUrl: 'https://searxng.example',
            braveApiKey: 'brave-token',
            serpApiKey: null,
            serpApiEngine: null,
            serpApiGl: null,
            serpApiHl: null,
            providerTimeoutMs: 1000,
            maxResults: 4,
        });
        const result = await executor(createBaseInput());
        assert.equal(result.executionContext.status, 'executed');
        assert.equal(result.sources?.[0]?.url, 'https://brave.example/result');
        const payload = result.integrationContext?.payload as
            | {
                  attempts?: Array<{ provider: string; status: string }>;
              }
            | undefined;
        assert.equal(payload?.attempts?.[0]?.provider, 'searxng');
        assert.equal(payload?.attempts?.[0]?.status, 'failed');
        assert.equal(payload?.attempts?.[1]?.provider, 'brave');
        assert.equal(payload?.attempts?.[1]?.status, 'executed_with_results');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('web search executor returns skipped/tool_not_used when providers return empty results', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
        ({
            ok: true,
            json: async () => ({
                results: [],
            }),
        }) as Response;
    try {
        const executor = createWebSearchContextStepExecutor({
            enabled: true,
            providerPriority: ['searxng'],
            searxngBaseUrl: 'https://searxng.example',
            braveApiKey: null,
            serpApiKey: null,
            serpApiEngine: null,
            serpApiGl: null,
            serpApiHl: null,
            providerTimeoutMs: 1000,
            maxResults: 4,
        });
        const result = await executor(createBaseInput());
        assert.equal(result.executionContext.status, 'skipped');
        assert.equal(result.executionContext.reasonCode, 'tool_not_used');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('web search executor returns skipped/tool_unavailable when all providers are skipped', async () => {
    const executor = createWebSearchContextStepExecutor({
        enabled: true,
        providerPriority: ['searxng', 'brave'],
        searxngBaseUrl: null,
        braveApiKey: null,
        serpApiKey: null,
        serpApiEngine: null,
        serpApiGl: null,
        serpApiHl: null,
        providerTimeoutMs: 1000,
        maxResults: 4,
    });
    const result = await executor(createBaseInput());
    assert.equal(result.executionContext.status, 'skipped');
    assert.equal(result.executionContext.reasonCode, 'tool_unavailable');
});

test('web search executor falls back to serpapi when searxng and brave are unavailable', async () => {
    const originalFetch = globalThis.fetch;
    let observedUrl = '';
    globalThis.fetch = async (url) => {
        observedUrl = String(url);
        return {
            ok: true,
            json: async () => ({
                organic_results: [
                    {
                        title: 'SerpAPI result',
                        link: 'https://serpapi.example/result',
                        snippet: 'SerpAPI fallback worked',
                    },
                ],
            }),
        } as Response;
    };
    try {
        const executor = createWebSearchContextStepExecutor({
            enabled: true,
            providerPriority: ['searxng', 'brave', 'serpapi'],
            searxngBaseUrl: null,
            braveApiKey: null,
            serpApiKey: 'serp-token',
            serpApiEngine: 'google',
            serpApiGl: 'us',
            serpApiHl: 'en',
            providerTimeoutMs: 1000,
            maxResults: 4,
        });
        const result = await executor(createBaseInput());
        assert.equal(result.executionContext.status, 'executed');
        assert.equal(
            result.sources?.[0]?.url,
            'https://serpapi.example/result'
        );
        const payload = result.integrationContext?.payload as
            | {
                  attempts?: Array<{ provider: string; status: string }>;
              }
            | undefined;
        assert.equal(payload?.attempts?.[0]?.provider, 'searxng');
        assert.equal(payload?.attempts?.[0]?.status, 'skipped');
        assert.equal(payload?.attempts?.[1]?.provider, 'brave');
        assert.equal(payload?.attempts?.[1]?.status, 'skipped');
        assert.equal(payload?.attempts?.[2]?.provider, 'serpapi');
        assert.equal(payload?.attempts?.[2]?.status, 'executed_with_results');
        assert.ok(observedUrl.includes('engine=google'));
        assert.ok(observedUrl.includes('gl=us'));
        assert.ok(observedUrl.includes('hl=en'));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('web search executor returns skipped/tool_unavailable when only serpapi is prioritized without key', async () => {
    const executor = createWebSearchContextStepExecutor({
        enabled: true,
        providerPriority: ['serpapi'],
        searxngBaseUrl: null,
        braveApiKey: null,
        serpApiKey: null,
        serpApiEngine: null,
        serpApiGl: null,
        serpApiHl: null,
        providerTimeoutMs: 1000,
        maxResults: 4,
    });
    const result = await executor(createBaseInput());
    assert.equal(result.executionContext.status, 'skipped');
    assert.equal(result.executionContext.reasonCode, 'tool_unavailable');
    const payload = result.integrationContext?.payload as
        | {
              attempts?: Array<{ provider: string; status: string }>;
          }
        | undefined;
    assert.equal(payload?.attempts?.[0]?.provider, 'serpapi');
    assert.equal(payload?.attempts?.[0]?.status, 'skipped');
});
