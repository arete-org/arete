/**
 * @description: Provides shared HTTP transport utilities for Discord bot backend API calls.
 * @arete-scope: utility
 * @arete-module: DiscordApiTransport
 * @arete-risk: moderate - Transport mistakes can break bot-side backend communication.
 * @arete-ethics: moderate - Normalized error handling supports transparent fail-open behavior.
 */

import {
    createApiTransport as createSharedApiTransport,
    isApiClientError as isSharedApiClientError,
    type ApiClientError,
    type ApiJsonResult,
    type ApiRequestOptions,
    type ApiRequester,
    type CreateApiTransportOptions as SharedCreateApiTransportOptions,
} from '@arete/contracts/web/client-core';
import type { ApiErrorResponse } from '@arete/contracts/web';

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
