/**
 * @description: Covers the Discord bot reflect API client wrapper.
 * @footnote-scope: test
 * @footnote-module: DiscordReflectApiTests
 * @footnote-risk: low - These tests validate transport wiring and error propagation only.
 * @footnote-ethics: medium - Stable backend reflect transport keeps shared reasoning paths predictable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { PostReflectRequest } from '@footnote/contracts/web';
import type {
    ApiJsonResult,
    ApiRequestOptions,
    ApiRequester,
} from '../src/api/client.js';
import { createReflectApi } from '../src/api/reflect.js';

const createReflectRequest = (
    overrides: Partial<PostReflectRequest> = {}
): PostReflectRequest => ({
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

test('reflectViaApi posts to /api/reflect with X-Trace-Token and returns parsed data', async () => {
    const request = createReflectRequest();
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
                    riskTier: 'Low',
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

    const api = createReflectApi(requestJson, {
        traceApiToken: 'trace-secret',
    });

    const response = await api.reflectViaApi(request);

    assert.equal(capturedEndpoint, '/api/reflect');
    assert.equal(capturedHeaders?.['X-Trace-Token'], 'trace-secret');
    assert.deepEqual(capturedBody, request);
    assert.equal(response.action, 'message');
    assert.equal(
        (response as { message?: string }).message,
        'backend response'
    );
});

test('reflectViaApi throws backend request errors so callers can handle them', async () => {
    const requestJson: ApiRequester = async () => {
        throw new Error('backend exploded');
    };
    const api = createReflectApi(requestJson);

    await assert.rejects(
        () => api.reflectViaApi(createReflectRequest()),
        /backend exploded/
    );
});

test('reflectViaApi tolerates unknown actions so the executor can fail safely', async () => {
    const requestJson: ApiRequester = async <T>(): Promise<
        ApiJsonResult<T>
    > => ({
        status: 200,
        data: {
            action: 'video',
            clipRequest: { prompt: 'animate this' },
        } as T,
    });
    const api = createReflectApi(requestJson);

    const response = await api.reflectViaApi(createReflectRequest());
    assert.equal(response.action, 'video');
});
