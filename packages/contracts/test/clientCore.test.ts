/**
 * @description: Validates shared API transport response validation and normalized errors.
 * @arete-scope: test
 * @arete-module: WebApiClientCoreTests
 * @arete-risk: low - Tests only cover transport behavior with stubbed fetch responses.
 * @arete-ethics: low - Uses synthetic payloads and no live external services.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
    createApiTransport,
    isApiClientError,
    type ApiResponseValidationResult,
} from '../src/web/client-core';

const jsonResponse = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
        },
    });

test('requestJson returns parsed payload when no response validator is provided', async () => {
    const { requestJson } = createApiTransport({
        fetchImpl: async () => jsonResponse({ ok: true }),
    });

    const response = await requestJson<{ ok: boolean }>('/api/example');

    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { ok: true });
});

test('requestJson returns validated data when response validator succeeds', async () => {
    const { requestJson } = createApiTransport({
        fetchImpl: async () => jsonResponse({ message: 'hello' }),
    });

    const response = await requestJson<{ normalized: string }>('/api/example', {
        validateResponse: (
            payload: unknown
        ): ApiResponseValidationResult<{ normalized: string }> => {
            if (
                payload &&
                typeof payload === 'object' &&
                typeof (payload as { message?: unknown }).message === 'string'
            ) {
                return {
                    success: true,
                    data: {
                        normalized: (payload as { message: string }).message,
                    },
                };
            }

            return {
                success: false,
                error: 'message must be a string',
            };
        },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { normalized: 'hello' });
});

test('requestJson throws invalid_payload when response validator reports failure', async () => {
    const { requestJson } = createApiTransport({
        fetchImpl: async () => jsonResponse({ wrong: true }),
    });

    await assert.rejects(
        requestJson<{ message: string }>('/api/example', {
            validateResponse: (): ApiResponseValidationResult<{
                message: string;
            }> => ({
                success: false,
                error: 'Expected message payload',
            }),
        }),
        (error: unknown) => {
            assert.equal(isApiClientError(error), true);
            assert.equal((error as { code?: unknown }).code, 'invalid_payload');
            assert.equal((error as { status?: unknown }).status, 200);
            assert.equal(
                (error as { message?: unknown }).message,
                'Expected message payload'
            );
            return true;
        }
    );
});

test('requestJson throws invalid_payload when response validator throws', async () => {
    const { requestJson } = createApiTransport({
        fetchImpl: async () => jsonResponse({ wrong: true }),
    });

    await assert.rejects(
        requestJson<{ message: string }>('/api/example', {
            validateResponse: () => {
                throw new Error('validator exploded');
            },
        }),
        (error: unknown) => {
            assert.equal(isApiClientError(error), true);
            assert.equal((error as { code?: unknown }).code, 'invalid_payload');
            assert.equal(
                (error as { message?: unknown }).message,
                'validator exploded'
            );
            return true;
        }
    );
});
