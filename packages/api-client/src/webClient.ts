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
