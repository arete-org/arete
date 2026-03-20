/**
 * @description: Validates the backend-owned image-description adapter that wraps provider transport and parsing.
 * @footnote-scope: test
 * @footnote-module: InternalImageDescriptionAdapterTests
 * @footnote-risk: medium - Missing coverage here could let provider request mapping or tool parsing drift without breaking route-level tests.
 * @footnote-ethics: medium - These checks help keep attachment grounding predictable and avoid silent OCR/description regressions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';

import {
    createOpenAiImageDescriptionAdapter,
    detectContentTypeFromUrl,
} from '../src/services/internalImageDescription.js';

const publicLookup: typeof dns.lookup = async (_hostname, options) => {
    const resolvedAddress = {
        address: '93.184.216.34',
        family: 4 as const,
    };

    if (typeof options === 'object' && options?.all) {
        return [resolvedAddress];
    }

    return resolvedAddress;
};

test('image-description adapter downloads the image, sends a data URL, and returns normalized usage', async () => {
    const fetchCalls: Array<{
        url: string;
        init?: Parameters<typeof fetch>[1];
    }> = [];
    const adapter = createOpenAiImageDescriptionAdapter({
        apiKey: 'test-key',
        lookupImpl: publicLookup,
        fetchImpl: async (url, init) => {
            fetchCalls.push({ url: String(url), init });

            if (String(url) === 'https://example.com/image.png') {
                return new Response(Buffer.from('png-bytes'), {
                    status: 200,
                    headers: {
                        'content-type': 'image/png',
                    },
                });
            }

            return new Response(
                JSON.stringify({
                    choices: [
                        {
                            message: {
                                tool_calls: [
                                    {
                                        type: 'function',
                                        function: {
                                            name: 'describe_image',
                                            arguments: JSON.stringify({
                                                summary:
                                                    'Screenshot of a policy update.',
                                                detected_type: 'screenshot',
                                                extracted_text: [
                                                    'Policy update',
                                                ],
                                                structured: {
                                                    key_elements: [
                                                        'settings panel',
                                                    ],
                                                },
                                                certainty: 'high',
                                            }),
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                    usage: {
                        prompt_tokens: 12,
                        completion_tokens: 8,
                        total_tokens: 20,
                    },
                }),
                {
                    status: 200,
                    headers: {
                        'content-type': 'application/json',
                    },
                }
            );
        },
    });

    const result = await adapter.describeImage({
        imageUrl: 'https://example.com/image.png',
        prompt: 'Describe the screenshot.',
    });

    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0]?.url, 'https://example.com/image.png');
    assert.equal(
        fetchCalls[1]?.url,
        'https://api.openai.com/v1/chat/completions'
    );

    const requestBody = JSON.parse(
        String(fetchCalls[1]?.init?.body ?? '{}')
    ) as {
        model: string;
        messages: Array<{
            content: Array<
                | { type: 'text'; text: string }
                | { type: 'image_url'; image_url: { url: string } }
            >;
        }>;
    };

    assert.equal(requestBody.model, 'gpt-4o-mini');
    assert.equal(requestBody.messages[0]?.content[0]?.type, 'text');
    assert.equal(
        (requestBody.messages[0]?.content[0] as { text: string }).text,
        'Describe the screenshot.'
    );
    assert.equal(requestBody.messages[0]?.content[1]?.type, 'image_url');
    assert.match(
        (requestBody.messages[0]?.content[1] as { image_url: { url: string } })
            .image_url.url,
        /^data:image\/png;base64,/
    );

    assert.equal(result.model, 'gpt-4o-mini');
    assert.equal(result.promptTokens, 12);
    assert.equal(result.completionTokens, 8);
    assert.equal(result.totalTokens, 20);
    assert.match(result.description, /Screenshot of a policy update/);
});

test('detectContentTypeFromUrl recovers common image content types from the URL path', () => {
    assert.equal(
        detectContentTypeFromUrl('https://example.com/image.webp'),
        'image/webp'
    );
    assert.equal(
        detectContentTypeFromUrl('https://example.com/photo.jpeg'),
        'image/jpeg'
    );
    assert.equal(detectContentTypeFromUrl('not-a-url'), null);
});

test('image-description adapter rejects downloads that omit an image content-type header', async () => {
    const adapter = createOpenAiImageDescriptionAdapter({
        apiKey: 'test-key',
        lookupImpl: publicLookup,
        fetchImpl: async (url, init) => {
            if (String(url) === 'https://example.com/image.webp') {
                return new Response(Buffer.from('webp-bytes'), {
                    status: 200,
                });
            }

            void init;
            return new Response(
                JSON.stringify({
                    choices: [
                        {
                            message: {
                                tool_calls: [
                                    {
                                        type: 'function',
                                        function: {
                                            name: 'describe_image',
                                            arguments: JSON.stringify({
                                                summary: 'Mock summary',
                                                detected_type: 'image',
                                                extracted_text: [],
                                                structured: {
                                                    key_elements: [],
                                                },
                                                certainty: 'medium',
                                            }),
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                }),
                { status: 200 }
            );
        },
    });

    await assert.rejects(
        () =>
            adapter.describeImage({
                imageUrl: 'https://example.com/image.webp',
                prompt: 'Describe this image.',
            }),
        /was not an image/i
    );
});

test('image-description adapter surfaces provider HTTP failures with a stable error', async () => {
    const adapter = createOpenAiImageDescriptionAdapter({
        apiKey: 'test-key',
        lookupImpl: publicLookup,
        fetchImpl: async (url) => {
            if (String(url) === 'https://example.com/image.png') {
                return new Response(Buffer.from('png-bytes'), {
                    status: 200,
                    headers: {
                        'content-type': 'image/png',
                    },
                });
            }

            return new Response('provider exploded', {
                status: 502,
                statusText: 'Bad Gateway',
            });
        },
    });

    await assert.rejects(
        () =>
            adapter.describeImage({
                imageUrl: 'https://example.com/image.png',
                prompt: 'Describe this image.',
            }),
        /Image-description request failed: 502 Bad Gateway - provider exploded/
    );
});

test('image-description adapter warns and fails when the tool payload is invalid JSON', async () => {
    const warnings: string[] = [];
    const adapter = createOpenAiImageDescriptionAdapter({
        apiKey: 'test-key',
        lookupImpl: publicLookup,
        logger: {
            warn(message) {
                warnings.push(message);
                return undefined as never;
            },
        },
        fetchImpl: async (url) => {
            if (String(url) === 'https://example.com/image.png') {
                return new Response(Buffer.from('png-bytes'), {
                    status: 200,
                    headers: {
                        'content-type': 'image/png',
                    },
                });
            }

            return new Response(
                JSON.stringify({
                    choices: [
                        {
                            message: {
                                tool_calls: [
                                    {
                                        type: 'function',
                                        function: {
                                            name: 'describe_image',
                                            arguments: '{bad json',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                }),
                { status: 200 }
            );
        },
    });

    await assert.rejects(
        () =>
            adapter.describeImage({
                imageUrl: 'https://example.com/image.png',
                prompt: 'Describe this image.',
            }),
        /Internal image-description task did not return a valid tool payload/
    );

    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /invalid tool JSON/i);
});

test('image-description adapter rejects non-HTTPS image URLs before fetching', async () => {
    const fetchCalls: string[] = [];
    const adapter = createOpenAiImageDescriptionAdapter({
        apiKey: 'test-key',
        lookupImpl: publicLookup,
        fetchImpl: async (url) => {
            fetchCalls.push(String(url));
            throw new Error('fetch should not be called');
        },
    });

    await assert.rejects(
        () =>
            adapter.describeImage({
                imageUrl: 'http://example.com/image.png',
                prompt: 'Describe this image.',
            }),
        /must use HTTPS/i
    );
    assert.deepEqual(fetchCalls, []);
});

test('image-description adapter rejects private-network image URLs before fetching', async () => {
    const fetchCalls: string[] = [];
    const adapter = createOpenAiImageDescriptionAdapter({
        apiKey: 'test-key',
        lookupImpl: publicLookup,
        fetchImpl: async (url) => {
            fetchCalls.push(String(url));
            throw new Error('fetch should not be called');
        },
    });

    await assert.rejects(
        () =>
            adapter.describeImage({
                imageUrl: 'https://127.0.0.1/image.png',
                prompt: 'Describe this image.',
            }),
        /host is not allowed/i
    );
    assert.deepEqual(fetchCalls, []);
});
