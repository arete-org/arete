/**
 * @description: Trace endpoint methods for Discord bot backend integration.
 * @footnote-scope: utility
 * @footnote-module: DiscordTraceApi
 * @footnote-risk: medium - Trace API failures reduce provenance reliability and debugging context.
 * @footnote-ethics: medium - Missing provenance data can weaken transparency and auditability.
 */

import type {
    GetTraceResponse,
    GetTraceStaleResponse,
    PostTracesRequest,
    PostTracesResponse,
} from '@footnote/contracts/web';
import {
    GetTraceApiResponseSchema,
    PostTracesResponseSchema,
    createSchemaResponseValidator,
} from '@footnote/contracts/web/schemas';
import type { ApiJsonResult, ApiRequester } from './client.js';

export type CreateTraceApiOptions = {
    traceApiToken?: string;
};

export type TraceApi = {
    postTraces: (
        request: PostTracesRequest,
        options?: { signal?: AbortSignal }
    ) => Promise<PostTracesResponse>;
    getTrace: (
        responseId: string,
        options?: { signal?: AbortSignal }
    ) => Promise<ApiJsonResult<GetTraceResponse | GetTraceStaleResponse>>;
};

export const createTraceApi = (
    requestJson: ApiRequester,
    { traceApiToken }: CreateTraceApiOptions = {}
): TraceApi => {
    /**
     * @api.operationId: postTraces
     * @api.path: POST /api/traces
     */
    const postTraces = async (
        request: PostTracesRequest,
        options?: { signal?: AbortSignal }
    ): Promise<PostTracesResponse> => {
        const headers: Record<string, string> = {};

        if (traceApiToken) {
            headers['X-Trace-Token'] = traceApiToken;
        }

        const response = await requestJson<PostTracesResponse>('/api/traces', {
            method: 'POST',
            headers,
            body: request,
            signal: options?.signal,
            validateResponse: createSchemaResponseValidator(
                PostTracesResponseSchema
            ),
        });

        return response.data;
    };

    /**
     * @api.operationId: getTrace
     * @api.path: GET /api/traces/{responseId}
     */
    const getTrace = async (
        responseId: string,
        options?: { signal?: AbortSignal }
    ): Promise<ApiJsonResult<GetTraceResponse | GetTraceStaleResponse>> => {
        const encodedResponseId = encodeURIComponent(responseId);
        return requestJson<GetTraceResponse | GetTraceStaleResponse>(
            `/api/traces/${encodedResponseId}`,
            {
                method: 'GET',
                signal: options?.signal,
                acceptedStatusCodes: [410],
                validateResponse: createSchemaResponseValidator(
                    GetTraceApiResponseSchema
                ),
            }
        );
    };

    return {
        postTraces,
        getTrace,
    };
};

