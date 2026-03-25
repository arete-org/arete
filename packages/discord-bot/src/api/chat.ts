/**
 * @description: Chat endpoint methods for Discord bot backend integration.
 * @footnote-scope: utility
 * @footnote-module: DiscordChatApi
 * @footnote-risk: medium - Chat API failures can break the bot's primary chat path.
 * @footnote-ethics: medium - Stable chat transport keeps backend reasoning and provenance visible to users.
 */
import type {
    PostChatRequest,
    PostChatResponse,
} from '@footnote/contracts/web';
import type { ApiRequester } from './client.js';

export type CreateChatApiOptions = {
    traceApiToken?: string;
};

export type UnknownChatActionResponse = {
    action: string;
    [key: string]: unknown;
};

export type DiscordChatApiResponse =
    | PostChatResponse
    | UnknownChatActionResponse;

export type ChatApi = {
    chatViaApi: (
        request: PostChatRequest,
        options?: { signal?: AbortSignal }
    ) => Promise<DiscordChatApiResponse>;
};

const isChatApiResponse = (
    value: unknown
): value is DiscordChatApiResponse =>
    Boolean(
        value &&
            typeof value === 'object' &&
            typeof (value as { action?: unknown }).action === 'string'
    );

export const createChatApi = (
    requestJson: ApiRequester,
    { traceApiToken }: CreateChatApiOptions = {}
): ChatApi => {
    /**
     * @api.operationId: postChat
     * @api.path: POST /api/chat
     */
    const chatViaApi = async (
        request: PostChatRequest,
        options?: { signal?: AbortSignal }
    ): Promise<DiscordChatApiResponse> => {
        const headers: Record<string, string> = {};

        if (traceApiToken) {
            headers['X-Trace-Token'] = traceApiToken;
        }

        const response = await requestJson<unknown>('/api/chat', {
            method: 'POST',
            headers,
            body: request,
            signal: options?.signal,
        });

        if (!isChatApiResponse(response.data)) {
            throw new Error(
                'Chat API response did not include an action discriminator.'
            );
        }

        return response.data;
    };

    return {
        chatViaApi,
    };
};
