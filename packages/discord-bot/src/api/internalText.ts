/**
 * @description: Trusted internal `/news` task endpoint methods for Discord bot backend integration.
 * @footnote-scope: utility
 * @footnote-module: DiscordInternalNewsApi
 * @footnote-risk: medium - Transport mistakes can break the backend-owned `/news` task.
 * @footnote-ethics: medium - Narrow task transport helps keep backend-owned generation policy explicit.
 */
import type {
    ApiErrorResponse,
    PostInternalNewsTaskRequest,
    PostInternalNewsTaskResponse,
} from '@footnote/contracts/web';
import {
    PostInternalNewsTaskResponseSchema,
    createSchemaResponseValidator,
} from '@footnote/contracts/web/schemas';
import type { ApiRequester } from './client.js';

export type CreateInternalNewsApiOptions = {
    traceApiToken?: string;
};

export type InternalNewsApi = {
    runNewsTaskViaApi: (
        request: PostInternalNewsTaskRequest,
        options?: { signal?: AbortSignal }
    ) => Promise<PostInternalNewsTaskResponse>;
};

const buildTrustedHeaders = (traceApiToken?: string): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (traceApiToken) {
        headers['X-Trace-Token'] = traceApiToken;
    }
    return headers;
};

const buildInternalTaskHttpError = (
    status: number,
    payload: unknown
): Error => {
    const responsePayload =
        payload && typeof payload === 'object'
            ? (payload as Partial<ApiErrorResponse>)
            : null;
    const details = [responsePayload?.error, responsePayload?.details]
        .filter((value): value is string => typeof value === 'string')
        .join(' - ');
    const message =
        details.length > 0
            ? `Internal news task request failed with status ${status}: ${details}`
            : `Internal news task request failed with status ${status}`;

    return new Error(message);
};

export const createInternalNewsApi = (
    requestJson: ApiRequester,
    { traceApiToken }: CreateInternalNewsApiOptions = {}
): InternalNewsApi => {
    const headers = buildTrustedHeaders(traceApiToken);

    /**
     * @api.operationId: postInternalTextTask
     * @api.path: POST /api/internal/text
     */
    const runNewsTaskViaApi = async (
        request: PostInternalNewsTaskRequest,
        options?: { signal?: AbortSignal }
    ): Promise<PostInternalNewsTaskResponse> => {
        const response = await requestJson<PostInternalNewsTaskResponse>(
            '/api/internal/text',
            {
                method: 'POST',
                headers,
                body: request,
                signal: options?.signal,
                validateResponse: createSchemaResponseValidator(
                    PostInternalNewsTaskResponseSchema
                ),
            }
        );

        if (response.status < 200 || response.status >= 300) {
            throw buildInternalTaskHttpError(response.status, response.data);
        }

        return response.data;
    };

    return {
        runNewsTaskViaApi,
    };
};
