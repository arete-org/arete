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
    createIncidentApi,
    type CreateIncidentApiOptions,
    type IncidentApi,
} from './incidents.js';
import {
    createReflectApi,
    type CreateReflectApiOptions,
    type ReflectApi,
} from './reflect.js';
import {
    createInternalImageApi,
    type CreateInternalImageApiOptions,
    type InternalImageApi,
} from './internalImage.js';
import {
    createInternalTextApi,
    type CreateInternalTextApiOptions,
    type InternalTextApi,
} from './internalText.js';
import {
    createTraceApi,
    type CreateTraceApiOptions,
    type TraceApi,
} from './traces.js';

export type CreateDiscordApiClientOptions = CreateApiTransportOptions &
    CreateIncidentApiOptions &
    CreateTraceApiOptions &
    CreateReflectApiOptions &
    CreateInternalImageApiOptions &
    CreateInternalTextApiOptions;

export type DiscordApiClient = {
    requestJson: ApiRequester;
} & TraceApi &
    ReflectApi &
    IncidentApi &
    InternalImageApi &
    InternalTextApi;

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
        ...createIncidentApi(requestJson, { traceApiToken }),
        ...createInternalImageApi(requestJson, {
            traceApiToken,
            baseUrl,
            defaultHeaders,
            defaultTimeoutMs,
            fetchImpl,
        }),
        ...createInternalTextApi(requestJson, { traceApiToken }),
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
export type { CreateIncidentApiOptions, IncidentApi } from './incidents.js';
export type {
    CreateInternalImageApiOptions,
    InternalImageApi,
} from './internalImage.js';
export type {
    CreateInternalTextApiOptions,
    InternalTextApi,
} from './internalText.js';
export type {
    GetIncidentResponse,
    GetIncidentsResponse,
    PostInternalImageGenerateRequest,
    PostInternalImageGenerateResponse,
    PostInternalImageDescriptionTaskRequest,
    PostInternalImageDescriptionTaskResponse,
    PostInternalNewsTaskRequest,
    PostInternalNewsTaskResponse,
    PostIncidentNotesRequest,
    PostIncidentNotesResponse,
    PostIncidentRemediationRequest,
    PostIncidentRemediationResponse,
    PostIncidentReportRequest,
    PostIncidentReportResponse,
    PostIncidentStatusRequest,
    PostIncidentStatusResponse,
    PostTraceCardFromTraceRequest,
    PostTraceCardFromTraceResponse,
    PostTraceCardRequest,
    PostTraceCardResponse,
    PostTracesRequest,
    PostTracesResponse,
} from '@footnote/contracts/web';
