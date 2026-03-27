/**
 * @description: Thin compatibility wrapper around the shared @footnote/api-client transport exports.
 * @footnote-scope: utility
 * @footnote-module: DiscordApiTransport
 * @footnote-risk: medium - Transport mistakes can break bot-side backend communication.
 * @footnote-ethics: medium - Normalized error handling supports transparent fail-open behavior.
 */
import {
    createApiTransport as createSharedApiTransport,
    isApiClientError as isSharedApiClientError,
    type ApiClientError,
    type ApiErrorResponse,
    type ApiJsonResult,
    type ApiRequestOptions,
    type ApiRequester,
    type CreateApiTransportOptions as SharedCreateApiTransportOptions,
} from '@footnote/api-client';

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
} =>
    createSharedApiTransport({
        baseUrl,
        defaultHeaders,
        defaultTimeoutMs,
        fetchImpl,
        clientErrorName: 'DiscordApiClientError',
    });

export type {
    ApiErrorResponse,
    ApiJsonResult,
    ApiRequestOptions,
    ApiRequester,
};
