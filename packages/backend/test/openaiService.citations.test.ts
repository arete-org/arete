/**
 * @description: Verifies citation preservation behavior in the backend OpenAI wrapper.
 * @footnote-scope: test
 * @footnote-module: OpenAIServiceCitationTests
 * @footnote-risk: high - Regressions here can silently drop retrieved source records and understate evidence chips.
 * @footnote-ethics: high - Preserving visible retrieval sources is central to Footnote's transparency contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildResponseMetadata,
    SimpleOpenAIService,
} from '../src/services/openaiService.js';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

type MockResponsePayload = {
    model?: string;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
    };
    output?: Array<{
        type?: string;
        role?: string;
        finish_reason?: string;
        content?: Array<{
            type?: string;
            text?: string;
            annotations?: Array<{
                type: string;
                url?: string;
                title?: string;
                start_index: number;
                end_index: number;
            }>;
        }>;
    }>;
    output_text?: string;
};

const createRetrievedResponsePayload = (
    text: string,
    annotations?: Array<{
        type: string;
        url?: string;
        title?: string;
        start_index: number;
        end_index: number;
    }>
): MockResponsePayload => ({
    model: 'gpt-5-mini-2025-08-07',
    usage: {
        input_tokens: 120,
        output_tokens: 80,
        total_tokens: 200,
    },
    output: [
        { type: 'web_search_call' },
        {
            type: 'message',
            role: 'assistant',
            finish_reason: 'stop',
            content: [
                {
                    type: 'output_text',
                    text,
                    ...(annotations !== undefined ? { annotations } : {}),
                },
            ],
        },
    ],
});

const withMockedFetch = async (
    handler: (input: FetchInput, init?: FetchInit) => Promise<Response>,
    run: () => Promise<void>
): Promise<void> => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = handler as typeof fetch;

    try {
        await run();
    } finally {
        globalThis.fetch = originalFetch;
    }
};

test('SimpleOpenAIService recovers markdown-link citations when retrieval annotations are missing', async () => {
    const service = new SimpleOpenAIService('test-key');

    await withMockedFetch(
        async () =>
            new Response(
                JSON.stringify(
                    createRetrievedResponsePayload(
                        'Recent headlines: [1](https://example.com/a) [2](https://example.com/b) [2](https://example.com/b)'
                    )
                ),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }
            ),
        async () => {
            const result = await service.generateResponse(
                'gpt-5-mini',
                [{ role: 'user', content: 'What happened today?' }],
                {
                    search: {
                        query: 'latest news',
                        contextSize: 'low',
                        intent: 'current_facts',
                    },
                }
            );

            assert.equal(result.metadata.provenance, 'Retrieved');
            assert.deepEqual(result.metadata.citations, [
                { title: 'Source', url: 'https://example.com/a' },
                { title: 'Source', url: 'https://example.com/b' },
            ]);
        }
    );
});

test('SimpleOpenAIService preserves meaningful markdown labels in recovered citations', async () => {
    const service = new SimpleOpenAIService('test-key');

    await withMockedFetch(
        async () =>
            new Response(
                JSON.stringify(
                    createRetrievedResponsePayload(
                        'See [Indiana Capital Chronicle](https://example.com/news) for details.'
                    )
                ),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }
            ),
        async () => {
            const result = await service.generateResponse(
                'gpt-5-mini',
                [{ role: 'user', content: 'What happened today?' }],
                {
                    search: {
                        query: 'latest news',
                        contextSize: 'low',
                        intent: 'current_facts',
                    },
                }
            );

            assert.deepEqual(result.metadata.citations, [
                {
                    title: 'Indiana Capital Chronicle',
                    url: 'https://example.com/news',
                },
            ]);
        }
    );
});

test('SimpleOpenAIService does not run markdown fallback when annotation citations already exist', async () => {
    const service = new SimpleOpenAIService('test-key');

    await withMockedFetch(
        async () =>
            new Response(
                JSON.stringify(
                    createRetrievedResponsePayload(
                        'See [1](https://example.com/fallback)',
                        [
                            {
                                type: 'url_citation',
                                url: 'https://example.com/annotated',
                                title: 'Annotated Source',
                                start_index: 4,
                                end_index: 10,
                            },
                        ]
                    )
                ),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }
            ),
        async () => {
            const result = await service.generateResponse(
                'gpt-5-mini',
                [{ role: 'user', content: 'What happened today?' }],
                {
                    search: {
                        query: 'latest news',
                        contextSize: 'low',
                        intent: 'current_facts',
                    },
                }
            );

            assert.deepEqual(result.metadata.citations, [
                {
                    title: 'Annotated Source',
                    url: 'https://example.com/annotated',
                    snippet: '[1](ht',
                },
            ]);
        }
    );
});

test('SimpleOpenAIService does not recover markdown citations for non-retrieved replies', async () => {
    const service = new SimpleOpenAIService('test-key');

    await withMockedFetch(
        async () =>
            new Response(
                JSON.stringify({
                    model: 'gpt-5-mini-2025-08-07',
                    usage: {
                        input_tokens: 120,
                        output_tokens: 80,
                        total_tokens: 200,
                    },
                    output: [
                        {
                            type: 'message',
                            role: 'assistant',
                            finish_reason: 'stop',
                            content: [
                                {
                                    type: 'output_text',
                                    text: 'Reference [1](https://example.com/ignored)',
                                },
                            ],
                        },
                    ],
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }
            ),
        async () => {
            const result = await service.generateResponse('gpt-5-mini', [
                { role: 'user', content: 'Summarize this.' },
            ]);

            assert.equal(result.metadata.provenance, 'Inferred');
            assert.deepEqual(result.metadata.citations, []);
        }
    );
});

test('recovered markdown citations raise evidenceScore through the existing metadata heuristic', async () => {
    const service = new SimpleOpenAIService('test-key');

    await withMockedFetch(
        async () =>
            new Response(
                JSON.stringify(
                    createRetrievedResponsePayload(
                        'Recent headlines: [1](https://example.com/a) [2](https://example.com/b) [3](https://example.com/c) [4](https://example.com/d)'
                    )
                ),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }
            ),
        async () => {
            const result = await service.generateResponse(
                'gpt-5-mini',
                [{ role: 'user', content: 'What happened today?' }],
                {
                    search: {
                        query: 'latest news',
                        contextSize: 'low',
                        intent: 'current_facts',
                    },
                }
            );

            const metadata = buildResponseMetadata(
                {
                    model: result.metadata.model,
                    provenance: result.metadata.provenance,
                    citations: result.metadata.citations,
                },
                {
                    modelVersion: result.metadata.model,
                    conversationSnapshot: `What happened today?\n\n${result.normalizedText}`,
                    retrieval: {
                        requested: true,
                        used: true,
                        intent: 'current_facts',
                        contextSize: 'low',
                    },
                }
            );

            assert.equal(metadata.provenance, 'Retrieved');
            assert.equal(metadata.citations.length, 4);
            assert.equal(metadata.evidenceScore, 5);
            assert.equal(metadata.freshnessScore, 4);
        }
    );
});
