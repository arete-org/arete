/**
 * @description: Re-exports the shared Discord API client composition from @footnote/api-client.
 * @footnote-scope: utility
 * @footnote-module: DiscordApiClient
 * @footnote-risk: medium - Misconfigured client settings can break bot/backend communication.
 * @footnote-ethics: medium - Consistent API behavior supports predictable fail-open handling.
 */
export {
    createDiscordApiClient,
    type CreateDiscordApiClientOptions,
    type DiscordApiClient,
    type CreateIncidentApiOptions,
    type IncidentApi,
    type CreateInternalImageApiOptions,
    type InternalImageApi,
    type CreateInternalTextApiOptions,
    type InternalTextApi,
    type CreateInternalVoiceApiOptions,
    type InternalVoiceApi,
    type CreateTraceApiOptions,
    type TraceApi,
    type DiscordChatApiResponse,
    type UnknownChatActionResponse,
} from '@footnote/api-client';

export type {
    ApiErrorResponse,
    ApiJsonResult,
    ApiRequestOptions,
} from './client.js';
export type { DiscordApiClientError } from './client.js';
export { isDiscordApiClientError } from './client.js';

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
