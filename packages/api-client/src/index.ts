/**
 * @description: Shared package that composes typed backend API clients for Footnote web and Discord surfaces.
 * @footnote-scope: interface
 * @footnote-module: SharedApiClient
 * @footnote-risk: high - Miswired client composition can break multiple surface-to-backend integrations at once.
 * @footnote-ethics: medium - Stable transport and schema validation help preserve transparent, fail-open behavior.
 */
import {
    createApiTransport,
    isApiClientError,
    type ApiClientError,
    type ApiErrorResponse,
    type ApiJsonResult,
    type ApiRequestOptions,
    type ApiRequester,
    type CreateApiTransportOptions,
} from './client.js';
import {
    createIncidentApi,
    type CreateIncidentApiOptions,
    type IncidentApi,
} from './incidents.js';
import {
    createChatApi,
    type CreateChatApiOptions,
    type ChatApi,
    type DiscordChatApiResponse,
    type UnknownChatActionResponse,
} from './chat.js';
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
    createInternalVoiceApi,
    type CreateInternalVoiceApiOptions,
    type InternalVoiceApi,
} from './internalVoice.js';
import {
    createTraceApi,
    type CreateTraceApiOptions,
    type TraceApi,
} from './traces.js';
import { createWebReadApi, type WebReadApi } from './web.js';

export type CreateDiscordApiClientOptions = CreateApiTransportOptions &
    {
        baseUrl: string;
    } &
    CreateIncidentApiOptions &
    CreateTraceApiOptions &
    CreateChatApiOptions &
    CreateInternalImageApiOptions &
    CreateInternalTextApiOptions &
    CreateInternalVoiceApiOptions;

export type DiscordApiClient = {
    requestJson: ApiRequester;
} & TraceApi &
    ChatApi &
    IncidentApi &
    InternalImageApi &
    InternalTextApi &
    InternalVoiceApi;

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
        clientErrorName: 'DiscordApiClientError',
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
        ...createInternalVoiceApi(requestJson, { traceApiToken }),
        ...createChatApi(requestJson, { traceApiToken }),
        ...createTraceApi(requestJson, { traceApiToken }),
    };
};

export const isDiscordApiClientError = (
    value: unknown
): value is ApiClientError => isApiClientError(value, 'DiscordApiClientError');

export type CreateWebApiClientOptions = CreateApiTransportOptions;

export type WebApiClient = {
    requestJson: ApiRequester;
    chatQuestion: ChatApi['chatQuestion'];
} & WebReadApi;

export const createWebApiClient = ({
    baseUrl,
    defaultHeaders,
    defaultTimeoutMs,
    fetchImpl = fetch,
}: CreateWebApiClientOptions = {}): WebApiClient => {
    const { requestJson } = createApiTransport({
        baseUrl,
        defaultHeaders,
        defaultTimeoutMs,
        fetchImpl,
        clientErrorName: 'ApiClientError',
    });
    const chatApi = createChatApi(requestJson);
    const webReadApi = createWebReadApi(requestJson);

    return {
        requestJson,
        chatQuestion: chatApi.chatQuestion,
        ...webReadApi,
    };
};

export { createApiTransport, isApiClientError };
export {
    createChatApi,
    createIncidentApi,
    createInternalImageApi,
    createInternalTextApi,
    createInternalVoiceApi,
    createTraceApi,
    createWebReadApi,
};
export type { ApiClientError, ApiErrorResponse, ApiJsonResult, ApiRequestOptions };
export type {
    ApiRequester,
    ChatApi,
    CreateApiTransportOptions,
    CreateChatApiOptions,
    CreateIncidentApiOptions,
    CreateInternalImageApiOptions,
    CreateInternalTextApiOptions,
    CreateInternalVoiceApiOptions,
    CreateTraceApiOptions,
    DiscordChatApiResponse,
    IncidentApi,
    InternalImageApi,
    InternalTextApi,
    InternalVoiceApi,
    TraceApi,
    UnknownChatActionResponse,
    WebReadApi,
};
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
export type {
    PostInternalVoiceTtsRequest,
    PostInternalVoiceTtsResponse,
} from '@footnote/contracts/voice';
