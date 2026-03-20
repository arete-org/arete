/**
 * @description: Covers the OpenAI-backed image runtime adapter.
 * @footnote-scope: test
 * @footnote-module: OpenAiImageRuntimeTests
 * @footnote-risk: medium - Missing tests could let provider mapping or artifact normalization drift silently.
 * @footnote-ethics: medium - These checks protect prompt redaction and normalized image-result transparency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createOpenAiImageRuntime,
    type ImageGenerationRequest,
    type OpenAiImageRuntimeResponseClient,
    type OpenAiImageRuntimeResponseStream,
} from '../src/index.js';

const createRequest = (
    overrides: Partial<ImageGenerationRequest> = {}
): ImageGenerationRequest => ({
    prompt: 'draw a reflective skyline',
    systemPrompt: 'system prompt',
    developerPrompt: 'developer prompt',
    textModel: 'gpt-5-mini',
    imageModel: 'gpt-image-1-mini',
    quality: 'medium',
    size: '1024x1024',
    background: 'auto',
    style: 'vivid',
    allowPromptAdjustment: true,
    outputFormat: 'png',
    outputCompression: 90,
    ...overrides,
});

const createResponseStream = (
    response: Awaited<
        ReturnType<OpenAiImageRuntimeResponseClient['createResponse']>
    >,
    partialImages: string[] = []
): OpenAiImageRuntimeResponseStream => {
    const partialImageListeners: Array<
        (event: {
            partial_image_index: number;
            partial_image_b64: string;
        }) => void
    > = [];
    const errorListeners: Array<(error: unknown) => void> = [];
    const failedListeners: Array<
        (event: {
            response?: { error?: { code?: string; message?: string } };
        }) => void
    > = [];

    return {
        on(event, listener) {
            if (event === 'response.image_generation_call.partial_image') {
                partialImageListeners.push(
                    listener as (event: {
                        partial_image_index: number;
                        partial_image_b64: string;
                    }) => void
                );
                return;
            }

            if (event === 'error') {
                errorListeners.push(listener as (error: unknown) => void);
                return;
            }

            failedListeners.push(
                listener as (event: {
                    response?: { error?: { code?: string; message?: string } };
                }) => void
            );
        },
        async finalResponse() {
            for (const [index, base64] of partialImages.entries()) {
                for (const listener of partialImageListeners) {
                    listener({
                        partial_image_index: index,
                        partial_image_b64: base64,
                    });
                }
            }

            void errorListeners;
            void failedListeners;
            return response;
        },
    };
};

test('openai image runtime maps request payload and normalizes response artifacts', async () => {
    let seenPayload: Record<string, unknown> | undefined;
    const imageResponse: Awaited<
        ReturnType<OpenAiImageRuntimeResponseClient['createResponse']>
    > = {
        id: 'resp_123',
        output: [
            {
                type: 'image_generation_call',
                result: 'base64-image',
                revised_prompt: 'draw a reflective skyline at dusk',
                style_preset: 'vivid',
            },
            {
                type: 'message',
                content: [
                    {
                        type: 'output_text',
                        text: JSON.stringify({
                            title: 'Reflective Skyline',
                            description: 'A city scene at dusk.',
                            note: 'The skyline emphasizes calm light.',
                            adjusted_prompt:
                                'draw a reflective skyline at dusk',
                        }),
                    },
                ],
            },
        ],
        usage: {
            input_tokens: 42,
            output_tokens: 18,
            total_tokens: 60,
        },
        error: null,
    } as unknown as Awaited<
        ReturnType<OpenAiImageRuntimeResponseClient['createResponse']>
    >;
    const runtime = createOpenAiImageRuntime({
        client: {
            async createResponse(payload) {
                seenPayload = payload as unknown as Record<string, unknown>;
                return imageResponse;
            },
        },
    });

    const result = await runtime.generateImage(
        createRequest({
            followUpResponseId: 'resp_previous',
        })
    );

    assert.equal(seenPayload?.model, 'gpt-5-mini');
    assert.equal(seenPayload?.previous_response_id, 'resp_previous');
    assert.equal(result.responseId, 'resp_123');
    assert.equal(result.finalImageBase64, 'base64-image');
    assert.equal(result.revisedPrompt, 'draw a reflective skyline at dusk');
    assert.equal(result.annotations.title, 'Reflective Skyline');
    assert.equal(result.costs.image, 0.011);
    assert.equal(result.costs.perImage, 0.011);
    assert.equal(result.costs.total > result.costs.image, true);
    assert.equal(result.outputCompression, 100);
});

test('openai image runtime redacts prompt text in debug logs', async () => {
    const debugLogs: Array<{
        message: string;
        data?: Record<string, unknown>;
    }> = [];
    const imageResponse: Awaited<
        ReturnType<OpenAiImageRuntimeResponseClient['createResponse']>
    > = {
        id: 'resp_123',
        output: [
            {
                type: 'image_generation_call',
                result: 'base64-image',
                style_preset: 'vivid',
            },
        ],
        usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
        },
        error: null,
    } as unknown as Awaited<
        ReturnType<OpenAiImageRuntimeResponseClient['createResponse']>
    >;
    const runtime = createOpenAiImageRuntime({
        client: {
            async createResponse() {
                return imageResponse;
            },
        },
        logger: {
            debug(message, data) {
                debugLogs.push({ message, data });
            },
        },
    });

    await runtime.generateImage(
        createRequest({
            prompt: 'PRIVATE USER PROMPT',
            systemPrompt: 'PRIVATE SYSTEM PROMPT',
            developerPrompt: 'PRIVATE DEVELOPER PROMPT',
        })
    );

    assert.equal(debugLogs.length, 1);
    const payload = debugLogs[0].data?.payload as {
        input?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const texts =
        payload.input?.flatMap((entry) =>
            (entry.content ?? []).map((part) => part.text ?? '')
        ) ?? [];
    assert.deepEqual(texts, [
        '[REDACTED_PROMPT_TEXT]',
        '[REDACTED_PROMPT_TEXT]',
        '[REDACTED_PROMPT_TEXT]',
    ]);
});

test('openai image runtime emits partial-image callbacks when streaming is enabled', async () => {
    const partialImages: Array<{ index: number; base64: string }> = [];
    const eventOrder: string[] = [];
    let streamedPayload: Record<string, unknown> | undefined;
    const imageResponse: Awaited<
        ReturnType<OpenAiImageRuntimeResponseClient['createResponse']>
    > = {
        id: 'resp_stream_123',
        output: [
            {
                type: 'image_generation_call',
                result: 'final-base64-image',
                style_preset: 'vivid',
            },
        ],
        usage: {
            input_tokens: 5,
            output_tokens: 3,
            total_tokens: 8,
        },
        error: null,
    } as unknown as Awaited<
        ReturnType<OpenAiImageRuntimeResponseClient['createResponse']>
    >;
    const runtime = createOpenAiImageRuntime({
        client: {
            async createResponse() {
                throw new Error('non-streaming path should not be used');
            },
            async streamResponse(payload) {
                streamedPayload = payload as unknown as Record<string, unknown>;
                return createResponseStream(imageResponse, [
                    'partial-one',
                    'partial-two',
                ]);
            },
        },
    });

    const result = await runtime.generateImage(
        createRequest({
            stream: true,
            onPartialImage(payload) {
                partialImages.push(payload);
                eventOrder.push(`partial-${payload.index}`);
            },
        })
    );
    eventOrder.push('final');

    assert.deepEqual(partialImages, [
        { index: 0, base64: 'partial-one' },
        { index: 1, base64: 'partial-two' },
    ]);
    assert.deepEqual(eventOrder, ['partial-0', 'partial-1', 'final']);
    assert.equal(
        (
            (streamedPayload?.tools as Array<{
                partial_images?: number;
            }>)?.[0]?.partial_images ?? null
        ),
        1
    );
    assert.equal(result.finalImageBase64, 'final-base64-image');
});

test('openai image runtime maps provider errors into stable adapter errors', async () => {
    const runtime = createOpenAiImageRuntime({
        client: {
            async createResponse() {
                return {
                    id: 'resp_123',
                    output: [],
                    usage: undefined,
                    error: {
                        code: 'rate_limit_exceeded',
                        message: 'Too many requests',
                    },
                };
            },
        },
    });

    await assert.rejects(
        () => runtime.generateImage(createRequest()),
        /rate limit/i
    );
});
