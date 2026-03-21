/**
 * @description: Trusted internal `/voice/tts` endpoint methods for Discord bot backend integration.
 * @footnote-scope: utility
 * @footnote-module: DiscordInternalVoiceApi
 * @footnote-risk: medium - Transport mistakes can break the backend-owned voice TTS task.
 * @footnote-ethics: high - Voice synthesis requests carry user text and must stay within trusted boundaries.
 */
import type {
    PostInternalVoiceTtsRequest,
    PostInternalVoiceTtsResponse,
} from '@footnote/contracts/voice';
import { PostInternalVoiceTtsResponseSchema } from '@footnote/contracts/voice';
import { createSchemaResponseValidator } from '@footnote/contracts/web/schemas';
import type { ApiRequester } from './client.js';

export type CreateInternalVoiceApiOptions = {
    traceApiToken?: string;
};

export type InternalVoiceApi = {
    runVoiceTtsViaApi: (
        request: PostInternalVoiceTtsRequest,
        options?: { signal?: AbortSignal }
    ) => Promise<PostInternalVoiceTtsResponse>;
};

const buildTrustedHeaders = (
    traceApiToken?: string
): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (traceApiToken) {
        headers['X-Trace-Token'] = traceApiToken;
    }
    return headers;
};

export const createInternalVoiceApi = (
    requestJson: ApiRequester,
    { traceApiToken }: CreateInternalVoiceApiOptions = {}
): InternalVoiceApi => {
    const headers = buildTrustedHeaders(traceApiToken);

    /**
     * @api.operationId: postInternalVoiceTts
     * @api.path: POST /api/internal/voice/tts
     */
    const runVoiceTtsViaApi = async (
        request: PostInternalVoiceTtsRequest,
        options?: { signal?: AbortSignal }
    ): Promise<PostInternalVoiceTtsResponse> => {
        const response = await requestJson<PostInternalVoiceTtsResponse>(
            '/api/internal/voice/tts',
            {
                method: 'POST',
                headers,
                body: request,
                signal: options?.signal,
                validateResponse: createSchemaResponseValidator(
                    PostInternalVoiceTtsResponseSchema
                ),
            }
        );

        return response.data;
    };

    return {
        runVoiceTtsViaApi,
    };
};
