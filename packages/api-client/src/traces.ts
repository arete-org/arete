/**
 * @description: Trace endpoint methods used by clients that create and read provenance artifacts.
 * @footnote-scope: utility
 * @footnote-module: SharedTraceApi
 * @footnote-risk: medium - Trace API failures reduce provenance reliability and debugging context.
 * @footnote-ethics: medium - Missing provenance data can weaken transparency and auditability.
 */
import type {
    GetTraceResponse,
    GetTraceStaleResponse,
    PostTraceCardFromTraceRequest,
    PostTraceCardFromTraceResponse,
    PostTraceCardRequest,
    PostTraceCardResponse,
    PostTracesRequest,
    PostTracesResponse,
} from '@footnote/contracts/web';
import {
    GetTraceApiResponseSchema,
    PostTraceCardFromTraceResponseSchema,
    PostTraceCardResponseSchema,
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
    postTraceCard: (
        request: PostTraceCardRequest,
        options?: { signal?: AbortSignal }
    ) => Promise<PostTraceCardResponse>;
    postTraceCardFromTrace: (
        request: PostTraceCardFromTraceRequest,
        options?: { signal?: AbortSignal }
    ) => Promise<PostTraceCardFromTraceResponse>;
};

const buildTraceHeaders = (
    traceApiToken: string | undefined
): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (traceApiToken) {
        headers['X-Trace-Token'] = traceApiToken;
    }
    return headers;
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
        const headers = buildTraceHeaders(traceApiToken);

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

    /**
     * @api.operationId: postTraceCards
     * @api.path: POST /api/trace-cards
     */
    const postTraceCard = async (
        request: PostTraceCardRequest,
        options?: { signal?: AbortSignal }
    ): Promise<PostTraceCardResponse> => {
        const headers = buildTraceHeaders(traceApiToken);

        const response = await requestJson<PostTraceCardResponse>(
            '/api/trace-cards',
            {
                method: 'POST',
                headers,
                body: request,
                signal: options?.signal,
                validateResponse: createSchemaResponseValidator(
                    PostTraceCardResponseSchema
                ),
            }
        );

        return response.data;
    };

    /**
     * @api.operationId: postTraceCardsFromTrace
     * @api.path: POST /api/trace-cards/from-trace
     */
    const postTraceCardFromTrace = async (
        request: PostTraceCardFromTraceRequest,
        options?: { signal?: AbortSignal }
    ): Promise<PostTraceCardFromTraceResponse> => {
        const headers = buildTraceHeaders(traceApiToken);

        const response = await requestJson<PostTraceCardFromTraceResponse>(
            '/api/trace-cards/from-trace',
            {
                method: 'POST',
                headers,
                body: request,
                signal: options?.signal,
                validateResponse: createSchemaResponseValidator(
                    PostTraceCardFromTraceResponseSchema
                ),
            }
        );

        return response.data;
    };

    return {
        postTraces,
        getTrace,
        postTraceCard,
        postTraceCardFromTrace,
    };
};
