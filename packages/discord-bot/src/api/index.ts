/**
 * @description: Composes the Discord bot package-local backend API client.
 * @footnote-scope: utility
 * @footnote-module: DiscordApiClient
 * @footnote-risk: medium - Misconfigured client settings can break bot/backend communication.
 * @footnote-ethics: medium - Consistent API behavior supports predictable fail-open handling.
 */

import {
    createApiTransport,
    type ApiRequester,
    type CreateApiTransportOptions,
} from './client.js';
import {
    createReflectApi,
    type CreateReflectApiOptions,
    type ReflectApi,
} from './reflect.js';
import {
    createTraceApi,
    type CreateTraceApiOptions,
    type TraceApi,
} from './traces.js';

export type CreateDiscordApiClientOptions = CreateApiTransportOptions &
    CreateTraceApiOptions &
    CreateReflectApiOptions;

export type DiscordApiClient = {
    requestJson: ApiRequester;
} & TraceApi &
    ReflectApi;

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
        ...createReflectApi(requestJson, { traceApiToken }),
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
    DiscordReflectApiResponse,
    UnknownReflectActionResponse,
} from './reflect.js';
export type {
    PostTraceCardFromTraceRequest,
    PostTraceCardFromTraceResponse,
    PostTraceCardRequest,
    PostTraceCardResponse,
    PostTracesRequest,
    PostTracesResponse,
} from '@footnote/contracts/web';

