/**
 * @description: Chat endpoint methods used by Footnote web and Discord clients.
 * @footnote-scope: utility
 * @footnote-module: SharedChatApi
 * @footnote-risk: medium - Chat API failures can break primary user conversation paths.
 * @footnote-ethics: medium - Stable chat transport keeps backend reasoning and provenance visible to users.
 */
import type {
    PostChatRequest,
    PostChatResponse,
} from '@footnote/contracts/web';
import {
    PostChatResponseSchema,
    createSchemaResponseValidator,
} from '@footnote/contracts/web/schemas';
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
    chatQuestion: (
        request: PostChatRequest,
        options?: { turnstileToken?: string; signal?: AbortSignal }
    ) => Promise<PostChatResponse>;
};

const isChatApiResponse = (
    value: unknown
): value is DiscordChatApiResponse =>
    Boolean(
        value &&
            typeof value === 'object' &&
            typeof (value as { action?: unknown }).action === 'string' &&
            (value as { action: string }).action.trim().length > 0
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

    /**
     * @api.operationId: postChat
     * @api.path: POST /api/chat
     */
    const chatQuestion = async (
        request: PostChatRequest,
        options?: { turnstileToken?: string; signal?: AbortSignal }
    ): Promise<PostChatResponse> => {
        const headers: Record<string, string> = {};

        if (options?.turnstileToken) {
            headers['x-turnstile-token'] = options.turnstileToken;
        }
        if (request.sessionId) {
            headers['x-session-id'] = request.sessionId;
        }

        const response = await requestJson<PostChatResponse>('/api/chat', {
            method: 'POST',
            headers,
            body: request,
            signal: options?.signal,
            validateResponse: createSchemaResponseValidator(
                PostChatResponseSchema
            ),
        });

        return response.data;
    };

    return {
        chatViaApi,
        chatQuestion,
    };
};
