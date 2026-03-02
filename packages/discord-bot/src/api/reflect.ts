/**
 * @description: Reflect endpoint methods for Discord bot backend integration.
 * @footnote-scope: utility
 * @footnote-module: DiscordReflectApi
 * @footnote-risk: medium - Reflect API failures can break the bot's primary chat path.
 * @footnote-ethics: medium - Stable reflect transport keeps backend reasoning and provenance visible to users.
 */
import type {
    PostReflectRequest,
    PostReflectResponse,
} from '@footnote/contracts/web';
import type { ApiRequester } from './client.js';

export type CreateReflectApiOptions = {
    traceApiToken?: string;
};

export type UnknownReflectActionResponse = {
    action: string;
    [key: string]: unknown;
};

export type DiscordReflectApiResponse =
    | PostReflectResponse
    | UnknownReflectActionResponse;

export type ReflectApi = {
    reflectViaApi: (
        request: PostReflectRequest,
        options?: { signal?: AbortSignal }
    ) => Promise<DiscordReflectApiResponse>;
};

const isReflectApiResponse = (
    value: unknown
): value is DiscordReflectApiResponse =>
    Boolean(
        value &&
            typeof value === 'object' &&
            typeof (value as { action?: unknown }).action === 'string'
    );

export const createReflectApi = (
    requestJson: ApiRequester,
    { traceApiToken }: CreateReflectApiOptions = {}
): ReflectApi => {
    /**
     * @api.operationId: postReflect
     * @api.path: POST /api/reflect
     */
    const reflectViaApi = async (
        request: PostReflectRequest,
        options?: { signal?: AbortSignal }
    ): Promise<DiscordReflectApiResponse> => {
        const headers: Record<string, string> = {};

        if (traceApiToken) {
            headers['X-Trace-Token'] = traceApiToken;
        }

        const response = await requestJson<unknown>('/api/reflect', {
            method: 'POST',
            headers,
            body: request,
            signal: options?.signal,
        });

        if (!isReflectApiResponse(response.data)) {
            throw new Error(
                'Reflect API response did not include an action discriminator.'
            );
        }

        return response.data;
    };

    return {
        reflectViaApi,
    };
};
