/**
 * @description: Provides shared HTTP transport utilities for Discord bot backend API calls.
 * @footnote-scope: utility
 * @footnote-module: DiscordApiTransport
 * @footnote-risk: moderate - Transport mistakes can break bot-side backend communication.
 * @footnote-ethics: moderate - Normalized error handling supports transparent fail-open behavior.
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

export type DiscordApiClientError = ApiClientError;

export type CreateApiTransportOptions = SharedCreateApiTransportOptions & {
    baseUrl: string;
};

export const isDiscordApiClientError = (
    value: unknown
): value is DiscordApiClientError =>
    isSharedApiClientError(value, 'DiscordApiClientError');

export const createApiTransport = ({
    baseUrl,
    defaultHeaders,
    defaultTimeoutMs = 30_000,
    fetchImpl = fetch,
}: CreateApiTransportOptions): {
    requestJson: ApiRequester;
} => {
    if (!baseUrl.trim()) {
        throw new Error('Discord API client requires a non-empty baseUrl.');
    }

    return createSharedApiTransport({
        baseUrl,
        defaultHeaders,
        defaultTimeoutMs,
        fetchImpl,
        clientErrorName: 'DiscordApiClientError',
    });
};

export type { ApiErrorResponse, ApiJsonResult, ApiRequestOptions, ApiRequester };

