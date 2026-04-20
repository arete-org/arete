/**
 * @description: Web-focused API client entrypoint that avoids importing Discord/internal API modules.
 * @footnote-scope: interface
 * @footnote-module: WebApiClientEntrypoint
 * @footnote-risk: medium - Incorrect exports can break browser API wiring for chat, config, blog, and trace reads.
 * @footnote-ethics: medium - Keeps response validation intact while reducing unnecessary startup code for web users.
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
    createChatApi,
    type ChatApi,
    type CreateChatApiOptions,
    type DiscordChatApiResponse,
    type UnknownChatActionResponse,
} from './chat.js';
import { createWebReadApi, type WebReadApi } from './web.js';

export type CreateWebApiClientOptions = CreateApiTransportOptions &
    Pick<CreateChatApiOptions, 'traceApiToken'>;

export type WebApiClient = {
    requestJson: ApiRequester;
    chatQuestion: ChatApi['chatQuestion'];
} & WebReadApi;

/**
 * @description: Creates the web API boundary client and wires `createApiTransport`, `createChatApi`, and `createWebReadApi`.
 * @param options - `CreateWebApiClientOptions` including transport options such as `clientErrorName` and chat options such as `traceApiToken`.
 * @returns Stable `WebApiClient` methods for JSON requests, chat, and web read endpoints.
 */
export const createWebApiClient = ({
    baseUrl,
    defaultHeaders,
    defaultTimeoutMs,
    fetchImpl = fetch,
    clientErrorName,
    traceApiToken,
}: CreateWebApiClientOptions = {}): WebApiClient => {
    const { requestJson } = createApiTransport({
        baseUrl,
        defaultHeaders,
        defaultTimeoutMs,
        fetchImpl,
        clientErrorName,
    });
    const chatApi = createChatApi(requestJson, { traceApiToken });
    const webReadApi = createWebReadApi(requestJson);

    return {
        requestJson,
        chatQuestion: chatApi.chatQuestion,
        ...webReadApi,
    };
};

export { createApiTransport, isApiClientError };
export { createChatApi, createWebReadApi };
export type {
    ApiClientError,
    ApiErrorResponse,
    ApiJsonResult,
    ApiRequestOptions,
    ApiRequester,
    ChatApi,
    CreateApiTransportOptions,
    CreateChatApiOptions,
    DiscordChatApiResponse,
    UnknownChatActionResponse,
    WebReadApi,
};
