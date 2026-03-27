/**
 * @description: Thin compatibility wrapper around the shared chat API factory from @footnote/api-client.
 * @footnote-scope: utility
 * @footnote-module: DiscordChatApi
 * @footnote-risk: medium - Chat API failures can break the bot's primary chat path.
 * @footnote-ethics: medium - Stable chat transport keeps backend reasoning and provenance visible to users.
 */
import {
    createChatApi as createSharedChatApi,
    type ChatApi,
    type CreateChatApiOptions,
    type DiscordChatApiResponse,
    type UnknownChatActionResponse,
} from '@footnote/api-client';
import type { ApiRequester } from './client.js';

export type {
    ChatApi,
    CreateChatApiOptions,
    DiscordChatApiResponse,
    UnknownChatActionResponse,
};

export const createChatApi = (
    requestJson: ApiRequester,
    options: CreateChatApiOptions = {}
): ChatApi => createSharedChatApi(requestJson, options);
