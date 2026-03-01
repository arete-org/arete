/**
 * @description: Composes the Discord bot package-local backend API client.
 * @footnote-scope: utility
 * @footnote-module: DiscordApiClient
 * @footnote-risk: moderate - Misconfigured client settings can break bot/backend communication.
 * @footnote-ethics: moderate - Consistent API behavior supports predictable fail-open handling.
 */

import {
    createApiTransport,
    type ApiRequester,
    type CreateApiTransportOptions,
} from './client.js';
import {
    createTraceApi,
    type CreateTraceApiOptions,
    type TraceApi,
} from './traces.js';

export type CreateDiscordApiClientOptions = CreateApiTransportOptions &
    CreateTraceApiOptions;

export type DiscordApiClient = {
    requestJson: ApiRequester;
} & TraceApi;

export const createDiscordApiClient = ({
    baseUrl,
    defaultHeaders,
    defaultTimeoutMs,
    fetchImpl,
    traceApiToken,
}: CreateDiscordApiClientOptions): DiscordApiClient => {
    const { requestJson } = createApiTransport({
        baseUrl,
        defaultHeaders,
        defaultTimeoutMs,
        fetchImpl,
    });

    return {
        requestJson,
        ...createTraceApi(requestJson, { traceApiToken }),
    };
};

export type {
    ApiErrorResponse,
    ApiJsonResult,
    ApiRequestOptions,
    DiscordApiClientError,
} from './client.js';
export { isDiscordApiClientError } from './client.js';
export type {
    PostTracesRequest,
    PostTracesResponse,
} from '@footnote/contracts/web';

