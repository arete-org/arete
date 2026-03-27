/**
 * @description: Provides shared HTTP transport utilities for Footnote clients that call backend APIs.
 * @footnote-scope: utility
 * @footnote-module: SharedApiClientTransport
 * @footnote-risk: medium - Transport mistakes can break bot/web backend communication.
 * @footnote-ethics: medium - Consistent error handling supports transparent fail-open behavior.
 */
import {
    createApiTransport as createSharedApiTransport,
    isApiClientError as isSharedApiClientError,
    type ApiClientError,
    type ApiJsonResult,
    type ApiRequestOptions,
    type ApiRequester,
    type CreateApiTransportOptions as SharedCreateApiTransportOptions,
} from '@footnote/contracts/web/client-core';
import type { ApiErrorResponse } from '@footnote/contracts/web';

const DEFAULT_CLIENT_ERROR_NAME = 'FootnoteApiClientError';

export type { ApiClientError };
export type CreateApiTransportOptions = SharedCreateApiTransportOptions;

export const isApiClientError = (
    value: unknown,
    expectedName?: string
): value is ApiClientError =>
    isSharedApiClientError(value, expectedName ?? DEFAULT_CLIENT_ERROR_NAME);

export const createApiTransport = ({
    baseUrl,
    defaultHeaders,
    defaultTimeoutMs = 30_000,
    fetchImpl = fetch,
    clientErrorName = DEFAULT_CLIENT_ERROR_NAME,
}: CreateApiTransportOptions): {
    requestJson: ApiRequester;
} => {
    return createSharedApiTransport({
        baseUrl,
        defaultHeaders,
        defaultTimeoutMs,
        fetchImpl,
        clientErrorName,
    });
};

export type {
    ApiErrorResponse,
    ApiJsonResult,
    ApiRequestOptions,
    ApiRequester,
};
