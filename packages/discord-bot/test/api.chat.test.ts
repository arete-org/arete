/**
 * @description: Covers the Discord bot chat API client wrapper.
 * @footnote-scope: test
 * @footnote-module: DiscordChatApiTests
 * @footnote-risk: low - These tests validate transport wiring and error propagation only.
 * @footnote-ethics: medium - Stable backend chat transport keeps shared reasoning paths predictable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { PostChatRequest } from '@footnote/contracts/web';
import type {
    ApiJsonResult,
    ApiRequestOptions,
    ApiRequester,
} from '../src/api/client.js';
import { createChatApi } from '../src/api/chat.js';

const createChatRequest = (
    overrides: Partial<PostChatRequest> = {}
): PostChatRequest => ({
    surface: 'discord',
    trigger: { kind: 'direct', messageId: 'msg-1' },
    latestUserInput: 'What changed?',
    conversation: [
        {
            role: 'user',
            content: 'What changed?',
        },
    ],
    capabilities: {
        canReact: true,
        canGenerateImages: true,
        canUseTts: true,
    },
    ...overrides,
});

test('chatViaApi posts to /api/chat with X-Trace-Token and returns parsed data', async () => {
    const request = createChatRequest();
    let capturedEndpoint = '';
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: unknown;

    const requestJson: ApiRequester = async <T>(
        endpoint: string,
        options: ApiRequestOptions<T> = {}
    ): Promise<ApiJsonResult<T>> => {
        capturedEndpoint = endpoint;
        capturedHeaders = options.headers as Record<string, string>;
        capturedBody = options.body;
        return {
            status: 200,
            data: {
                action: 'message',
                message: 'backend response',
                modality: 'text',
                metadata: {
                    responseId: 'resp_123',
                    provenance: 'Inferred',
                    safetyTier: 'Low',
                    tradeoffCount: 0,
                    chainHash: 'hash_123',
                    licenseContext: 'MIT + HL3',
                    modelVersion: 'gpt-5-mini',
                    staleAfter: new Date(Date.now() + 60000).toISOString(),
                    citations: [],
                },
            } as T,
        };
    };

    const api = createChatApi(requestJson, {
        traceApiToken: 'trace-secret',
    });

    const response = await api.chatViaApi(request);

    assert.equal(capturedEndpoint, '/api/chat');
    assert.equal(capturedHeaders?.['X-Trace-Token'], 'trace-secret');
    assert.deepEqual(capturedBody, request);
    assert.equal(response.action, 'message');
    assert.equal(
        (response as { message?: string }).message,
        'backend response'
    );
});

test('chatViaApi throws backend request errors so callers can handle them', async () => {
    const requestJson: ApiRequester = async () => {
        throw new Error('backend exploded');
    };
    const api = createChatApi(requestJson);

    await assert.rejects(
        () => api.chatViaApi(createChatRequest()),
        /backend exploded/
    );
});

test('chatViaApi tolerates unknown actions so the executor can fail safely', async () => {
    const requestJson: ApiRequester = async <T>(): Promise<
        ApiJsonResult<T>
    > => ({
        status: 200,
        data: {
            action: 'video',
            clipRequest: { prompt: 'animate this' },
        } as T,
    });
    const api = createChatApi(requestJson);

    const response = await api.chatViaApi(createChatRequest());
    assert.equal(response.action, 'video');
});

test('getChatProfiles calls /api/chat/profiles and validates response shape', async () => {
    let capturedEndpoint = '';
    let capturedMethod = '';

    const requestJson: ApiRequester = async <T>(
        endpoint: string,
        options: ApiRequestOptions<T> = {}
    ): Promise<ApiJsonResult<T>> => {
        capturedEndpoint = endpoint;
        capturedMethod = options.method ?? 'GET';
        return {
            status: 200,
            data: {
                profiles: [
                    { id: 'openai-text-fast', description: 'Fast chat model' },
                    { id: 'openai-text-medium' },
                ],
            } as T,
        };
    };

    const api = createChatApi(requestJson);
    const response = await api.getChatProfiles();

    assert.equal(capturedEndpoint, '/api/chat/profiles');
    assert.equal(capturedMethod, 'GET');
    assert.deepEqual(response, {
        profiles: [
            { id: 'openai-text-fast', description: 'Fast chat model' },
            { id: 'openai-text-medium' },
        ],
    });
});

test('getChatProfiles surfaces transport errors', async () => {
    const requestJson: ApiRequester = async () => {
        throw new Error('profiles fetch failed');
    };
    const api = createChatApi(requestJson);

    await assert.rejects(() => api.getChatProfiles(), /profiles fetch failed/);
});
