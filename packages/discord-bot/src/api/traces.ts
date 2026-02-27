/**
 * @description: Trace endpoint methods for Discord bot backend integration.
 * @arete-scope: utility
 * @arete-module: DiscordTraceApi
 * @arete-risk: moderate - Trace API failures reduce provenance reliability and debugging context.
 * @arete-ethics: moderate - Missing provenance data can weaken transparency and auditability.
 */

import type {
    GetTraceResponse,
    GetTraceStaleResponse,
    PostTracesRequest,
    PostTracesResponse,
} from '@arete/contracts/web';
import type { ApiJsonResult, ApiRequester } from './client.js';

export type CreateTraceApiOptions = {
    traceApiToken?: string;
};

export const createTraceApi = (
    requestJson: ApiRequester,
    { traceApiToken }: CreateTraceApiOptions = {}
) => {
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
            headers['X-Arete-Trace-Token'] = traceApiToken;
        }

        const response = await requestJson<PostTracesResponse>('/api/traces', {
            method: 'POST',
            headers,
            body: request,
            signal: options?.signal,
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
            }
        );
    };

    return {
        postTraces,
        getTrace,
    };
};
