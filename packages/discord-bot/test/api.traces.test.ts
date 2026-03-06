/**
 * @description: Covers Discord bot trace API client wiring for trace upsert/read and trace-card creation.
 * @footnote-scope: test
 * @footnote-module: DiscordTraceApiTests
 * @footnote-risk: low - Tests validate transport wiring and schema validation behavior only.
 * @footnote-ethics: medium - Stable trace transport supports provenance visibility and auditability.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { PostTraceCardRequest } from '@footnote/contracts/web';
import type {
    ApiJsonResult,
    ApiRequestOptions,
    ApiRequester,
} from '../src/api/client.js';
import { createTraceApi } from '../src/api/traces.js';

const createTraceCardRequest = (
    overrides: Partial<PostTraceCardRequest> = {}
): PostTraceCardRequest => ({
    temperament: {
        tightness: 5,
        rationale: 3,
        attribution: 4,
        caution: 3,
        extent: 4,
    },
    chips: {
        evidenceScore: 4,
        freshnessScore: 5,
    },
    ...overrides,
});

test('postTraceCard posts to /api/trace-cards with X-Trace-Token and returns parsed data', async () => {
    const request = createTraceCardRequest();
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
                responseId: 'trace-card-preview-123',
                pngBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
            } as T,
        };
    };

    const api = createTraceApi(requestJson, { traceApiToken: 'trace-secret' });
    const response = await api.postTraceCard(request);

    assert.equal(capturedEndpoint, '/api/trace-cards');
    assert.equal(capturedHeaders?.['X-Trace-Token'], 'trace-secret');
    assert.deepEqual(capturedBody, request);
    assert.equal(response.responseId, 'trace-card-preview-123');
    assert.equal(response.pngBase64, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB');
});

test('postTraceCard throws backend request errors so callers can handle them', async () => {
    const requestJson: ApiRequester = async () => {
        throw new Error('trace-card backend failed');
    };
    const api = createTraceApi(requestJson);

    await assert.rejects(
        () => api.postTraceCard(createTraceCardRequest()),
        /trace-card backend failed/
    );
});

test('postTraceCardFromTrace posts by responseId and returns parsed data', async () => {
    let capturedEndpoint = '';
    let capturedBody: unknown;
    let capturedHeaders: Record<string, string> | undefined;

    const requestJson: ApiRequester = async <T>(
        endpoint: string,
        options: ApiRequestOptions<T> = {}
    ): Promise<ApiJsonResult<T>> => {
        capturedEndpoint = endpoint;
        capturedBody = options.body;
        capturedHeaders = options.headers as Record<string, string>;
        return {
            status: 200,
            data: {
                responseId: 'stored_response_123',
                pngBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
            } as T,
        };
    };

    const api = createTraceApi(requestJson, { traceApiToken: 'trace-secret' });
    const response = await api.postTraceCardFromTrace({
        responseId: 'stored_response_123',
    });

    assert.equal(capturedEndpoint, '/api/trace-cards/from-trace');
    assert.equal(capturedHeaders?.['X-Trace-Token'], 'trace-secret');
    assert.deepEqual(capturedBody, {
        responseId: 'stored_response_123',
    });
    assert.equal(response.responseId, 'stored_response_123');
});
