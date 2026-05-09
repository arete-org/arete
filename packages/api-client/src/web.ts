/**
 * @description: Read-oriented web endpoint methods used by browser and server-rendered web helpers.
 * @footnote-scope: utility
 * @footnote-module: SharedWebReadApi
 * @footnote-risk: medium - Request handling mistakes can break config and trace reading in the web surface.
 * @footnote-ethics: medium - Consistent error handling helps keep fallback behavior transparent.
 */
import type {
    GetRuntimeConfigResponse,
    GetTraceResponse,
    GetTraceStaleResponse,
} from '@footnote/contracts/web';
import type { ApiJsonResult, ApiRequester } from './client.js';
import { loadGetTraceApiResponseValidator } from './lazyWebValidators.js';

export type WebReadApi = {
    getRuntimeConfig: (
        signal?: AbortSignal
    ) => Promise<GetRuntimeConfigResponse>;
    getTrace: (
        responseId: string,
        signal?: AbortSignal
    ) => Promise<ApiJsonResult<GetTraceResponse | GetTraceStaleResponse>>;
};

export const createWebReadApi = (requestJson: ApiRequester): WebReadApi => {
    /**
     * @api.operationId: getRuntimeConfig
     * @api.path: GET /config.json
     */
    const getRuntimeConfig = async (
        signal?: AbortSignal
    ): Promise<GetRuntimeConfigResponse> => {
        const response = await requestJson<GetRuntimeConfigResponse>(
            '/config.json',
            {
                method: 'GET',
                signal,
                cache: 'no-store',
            }
        );
        return response.data;
    };

    /**
     * @api.operationId: getTrace
     * @api.path: GET /api/traces/{responseId}
     */
    const getTrace = async (
        responseId: string,
        signal?: AbortSignal
    ): Promise<ApiJsonResult<GetTraceResponse | GetTraceStaleResponse>> => {
        const validateResponse = await loadGetTraceApiResponseValidator();
        const encodedResponseId = encodeURIComponent(responseId);
        return requestJson<GetTraceResponse | GetTraceStaleResponse>(
            `/api/traces/${encodedResponseId}`,
            {
                method: 'GET',
                signal,
                headers: {
                    Accept: 'application/json',
                },
                acceptedStatusCodes: [410],
                validateResponse,
            }
        );
    };

    return {
        getRuntimeConfig,
        getTrace,
    };
};
