/**
 * @description: Trusted internal text-task endpoint methods for backend integration.
 * @footnote-scope: utility
 * @footnote-module: SharedInternalTextApi
 * @footnote-risk: medium - Transport mistakes can break backend-owned internal text tasks.
 * @footnote-ethics: medium - Narrow task transport keeps backend-owned generation policy explicit.
 */
import type {
    PostInternalImageDescriptionTaskRequest,
    PostInternalImageDescriptionTaskResponse,
    PostInternalNewsTaskRequest,
    PostInternalNewsTaskResponse,
} from '@footnote/contracts/web';
import {
    PostInternalImageDescriptionTaskResponseSchema,
    PostInternalNewsTaskResponseSchema,
    createSchemaResponseValidator,
} from '@footnote/contracts/web/schemas';
import type { ApiRequester } from './client.js';

export type CreateInternalTextApiOptions = {
    traceApiToken?: string;
};

export type InternalTextApi = {
    runNewsTaskViaApi: (
        request: PostInternalNewsTaskRequest,
        options?: { signal?: AbortSignal }
    ) => Promise<PostInternalNewsTaskResponse>;
    runImageDescriptionTaskViaApi: (
        request: PostInternalImageDescriptionTaskRequest,
        options?: { signal?: AbortSignal }
    ) => Promise<PostInternalImageDescriptionTaskResponse>;
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

export const createInternalTextApi = (
    requestJson: ApiRequester,
    { traceApiToken }: CreateInternalTextApiOptions = {}
): InternalTextApi => {
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

        return response.data;
    };

    /**
     * @api.operationId: postInternalTextTask
     * @api.path: POST /api/internal/text
     */
    const runImageDescriptionTaskViaApi = async (
        request: PostInternalImageDescriptionTaskRequest,
        options?: { signal?: AbortSignal }
    ): Promise<PostInternalImageDescriptionTaskResponse> => {
        const response =
            await requestJson<PostInternalImageDescriptionTaskResponse>(
                '/api/internal/text',
                {
                    method: 'POST',
                    headers,
                    body: request,
                    signal: options?.signal,
                    validateResponse: createSchemaResponseValidator(
                        PostInternalImageDescriptionTaskResponseSchema
                    ),
                }
            );

        return response.data;
    };

    return {
        runNewsTaskViaApi,
        runImageDescriptionTaskViaApi,
    };
};
