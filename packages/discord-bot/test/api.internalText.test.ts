/**
 * @description: Covers the Discord bot internal news-task API client wrapper.
 * @footnote-scope: test
 * @footnote-module: DiscordInternalNewsApiTests
 * @footnote-risk: low - These tests validate transport wiring and response validation only.
 * @footnote-ethics: medium - Stable trusted transport helps keep backend-owned text tasks predictable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { PostInternalNewsTaskRequest } from '@footnote/contracts/web';
import type {
    ApiJsonResult,
    ApiRequestOptions,
    ApiRequester,
} from '../src/api/client.js';
import { createInternalNewsApi } from '../src/api/internalText.js';

const createNewsRequest = (
    overrides: Partial<PostInternalNewsTaskRequest> = {}
): PostInternalNewsTaskRequest => ({
    task: 'news',
    query: 'latest ai policy',
    maxResults: 3,
    ...overrides,
});

test('runNewsTaskViaApi posts to /api/internal/text with trusted headers and returns parsed data', async () => {
    const request = createNewsRequest();
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
                task: 'news',
                result: {
                    news: [
                        {
                            title: 'Policy update',
                            summary: 'A concise summary',
                            url: 'https://example.com/news',
                            source: 'Example News',
                            timestamp: new Date().toISOString(),
                        },
                    ],
                    summary: 'One important headline today.',
                },
            } as T,
        };
    };

    const api = createInternalNewsApi(requestJson, {
        traceApiToken: 'trace-secret',
    });

    const response = await api.runNewsTaskViaApi(request);

    assert.equal(capturedEndpoint, '/api/internal/text');
    assert.equal(capturedHeaders?.['X-Trace-Token'], 'trace-secret');
    assert.deepEqual(capturedBody, request);
    assert.equal(response.task, 'news');
    assert.equal(response.result.news[0]?.title, 'Policy update');
});

test('runNewsTaskViaApi throws backend request errors so callers can handle them', async () => {
    const requestJson: ApiRequester = async () => {
        throw new Error('backend exploded');
    };
    const api = createInternalNewsApi(requestJson);

    await assert.rejects(
        () => api.runNewsTaskViaApi(createNewsRequest()),
        /backend exploded/
    );
});
