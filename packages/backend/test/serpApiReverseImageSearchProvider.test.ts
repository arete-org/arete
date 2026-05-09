/**
 * @description: Validates SerpAPI reverse-image provider mapping and fail-open error behavior.
 * @footnote-scope: test
 * @footnote-module: SerpApiReverseImageSearchProviderTests
 * @footnote-risk: medium - Parser regressions can drop citations or misclassify provider outcomes.
 * @footnote-ethics: medium - Reverse-image context quality affects user trust in provenance signals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSerpApiReverseImageSearchProvider } from '../src/services/contextIntegrations/reverseImageSearch/index.js';

test('SerpAPI provider maps visual matches into citations', async () => {
    const provider = createSerpApiReverseImageSearchProvider({
        apiKey: 'test-key',
        requestTimeoutMs: 1000,
        logger: { warn: () => undefined },
        fetchImpl: async () =>
            new Response(
                JSON.stringify({
                    visual_matches: [
                        {
                            title: 'Example Match',
                            link: 'https://example.com/match',
                            snippet: 'Matched listing',
                            confidence: '82%',
                        },
                    ],
                }),
                { status: 200 }
            ),
    });

    const result = await provider.search({
        imageUrl: 'https://images.example.com/input.jpg',
    });
    assert.equal(result.providerId, 'serpapi_google_lens');
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]?.title, 'Example Match');
    assert.equal(result.matches[0]?.url, 'https://example.com/match');
    assert.equal(result.matches[0]?.confidence, 0.82);
    assert.equal(result.confidence, undefined);
});

test('SerpAPI provider returns empty matches with no visual hits', async () => {
    let warned = false;
    const provider = createSerpApiReverseImageSearchProvider({
        apiKey: 'test-key',
        requestTimeoutMs: 1000,
        logger: {
            warn: () => {
                warned = true;
            },
        },
        fetchImpl: async () =>
            new Response(
                JSON.stringify({
                    visual_matches: [],
                    knowledge_graph: { title: 'Cargo vessel' },
                }),
                { status: 200 }
            ),
    });

    const result = await provider.search({
        imageUrl: 'https://images.example.com/input.jpg',
    });
    assert.equal(result.matches.length, 0);
    assert.equal(warned, false);
    assert.equal(typeof result.summary, 'string');
    assert.equal(result.confidence, undefined);
});

test('SerpAPI provider throws on non-2xx response', async () => {
    const provider = createSerpApiReverseImageSearchProvider({
        apiKey: 'test-key',
        requestTimeoutMs: 1000,
        logger: { warn: () => undefined },
        fetchImpl: async () =>
            new Response('bad request', {
                status: 400,
            }),
    });

    await assert.rejects(
        () =>
            provider.search({
                imageUrl: 'https://images.example.com/input.jpg',
            }),
        /SerpAPI reverse image search failed/
    );
});
