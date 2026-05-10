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
    globalThis.fetch = async () =>
        ({
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
        }) as Response;
    try {
        const executor = createWebSearchContextStepExecutor({
            enabled: true,
            providerPriority: ['searxng', 'brave'],
            searxngBaseUrl: 'https://searxng.example',
            braveApiKey: null,
            providerTimeoutMs: 1000,
            maxResults: 4,
        });
        const result = await executor(createBaseInput());
        assert.equal(result.executionContext.status, 'executed');
        assert.equal(result.sources?.[0]?.url, 'https://example.com/policy');
        assert.ok(
            result.contextMessages?.some((line) => line.includes('OpenAI'))
        );
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
