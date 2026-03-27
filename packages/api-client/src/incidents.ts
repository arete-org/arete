/**
 * @description: Incident endpoint methods for clients that integrate with backend review workflows.
 * @footnote-scope: utility
 * @footnote-module: SharedIncidentApi
 * @footnote-risk: medium - Incident API failures can block report submission and review tooling.
 * @footnote-ethics: high - Stable incident transport is required for durable reporting and privacy-safe review.
 */
import type {
    GetIncidentResponse,
    GetIncidentsResponse,
    PostIncidentNotesRequest,
    PostIncidentNotesResponse,
    PostIncidentRemediationRequest,
    PostIncidentRemediationResponse,
    PostIncidentReportRequest,
    PostIncidentReportResponse,
    PostIncidentStatusRequest,
    PostIncidentStatusResponse,
} from '@footnote/contracts/web';
import {
    GetIncidentResponseSchema,
    GetIncidentsResponseSchema,
    PostIncidentNotesResponseSchema,
    PostIncidentRemediationResponseSchema,
    PostIncidentReportResponseSchema,
    PostIncidentStatusResponseSchema,
    createSchemaResponseValidator,
} from '@footnote/contracts/web/schemas';
import type { ApiRequester } from './client.js';

export type CreateIncidentApiOptions = {
    traceApiToken?: string;
};

export type IncidentApi = {
    reportIncident: (
        request: PostIncidentReportRequest,
        options?: { signal?: AbortSignal }
    ) => Promise<PostIncidentReportResponse>;
    listIncidents: (
        filters?: {
            status?: string;
            tag?: string;
            createdFrom?: string;
            createdTo?: string;
        },
        options?: { signal?: AbortSignal }
    ) => Promise<GetIncidentsResponse>;
    getIncident: (
        incidentId: string,
        options?: { signal?: AbortSignal }
    ) => Promise<GetIncidentResponse>;
    updateIncidentStatus: (
        incidentId: string,
        request: PostIncidentStatusRequest,
        options?: { signal?: AbortSignal }
    ) => Promise<PostIncidentStatusResponse>;
    addIncidentNote: (
        incidentId: string,
        request: PostIncidentNotesRequest,
        options?: { signal?: AbortSignal }
    ) => Promise<PostIncidentNotesResponse>;
    recordIncidentRemediation: (
        incidentId: string,
        request: PostIncidentRemediationRequest,
        options?: { signal?: AbortSignal }
    ) => Promise<PostIncidentRemediationResponse>;
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

const toIncidentQueryString = (filters?: {
    status?: string;
    tag?: string;
    createdFrom?: string;
    createdTo?: string;
}): string => {
    if (!filters) {
        return '';
    }

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
        if (value === undefined || value === null) {
            continue;
        }

        const normalizedValue = String(value).trim();
        if (normalizedValue.length === 0) {
            continue;
        }

        params.set(key, normalizedValue);
    }

    const query = params.toString();
    return query ? `?${query}` : '';
};

export const createIncidentApi = (
    requestJson: ApiRequester,
    { traceApiToken }: CreateIncidentApiOptions = {}
): IncidentApi => {
    const headers = buildTrustedHeaders(traceApiToken);

    /**
     * @api.operationId: postIncidentReport
     * @api.path: POST /api/incidents/report
     */
    const reportIncident = async (
        request: PostIncidentReportRequest,
        options?: { signal?: AbortSignal }
    ): Promise<PostIncidentReportResponse> => {
        const response = await requestJson<PostIncidentReportResponse>(
            '/api/incidents/report',
            {
                method: 'POST',
                headers,
                body: request,
                signal: options?.signal,
                validateResponse: createSchemaResponseValidator(
                    PostIncidentReportResponseSchema
                ),
            }
        );

        return response.data;
    };

    /**
     * @api.operationId: listIncidents
     * @api.path: GET /api/incidents
     */
    const listIncidents = async (
        filters?: {
            status?: string;
            tag?: string;
            createdFrom?: string;
            createdTo?: string;
        },
        options?: { signal?: AbortSignal }
    ): Promise<GetIncidentsResponse> => {
        const response = await requestJson<GetIncidentsResponse>(
            `/api/incidents${toIncidentQueryString(filters)}`,
            {
                method: 'GET',
                headers,
                signal: options?.signal,
                validateResponse: createSchemaResponseValidator(
                    GetIncidentsResponseSchema
                ),
            }
        );

        return response.data;
    };

    /**
     * @api.operationId: getIncident
     * @api.path: GET /api/incidents/{incidentId}
     */
    const getIncident = async (
        incidentId: string,
        options?: { signal?: AbortSignal }
    ): Promise<GetIncidentResponse> => {
        const response = await requestJson<GetIncidentResponse>(
            `/api/incidents/${encodeURIComponent(incidentId)}`,
            {
                method: 'GET',
                headers,
                signal: options?.signal,
                validateResponse: createSchemaResponseValidator(
                    GetIncidentResponseSchema
                ),
            }
        );

        return response.data;
    };

    /**
     * @api.operationId: postIncidentStatus
     * @api.path: POST /api/incidents/{incidentId}/status
     */
    const updateIncidentStatus = async (
        incidentId: string,
        request: PostIncidentStatusRequest,
        options?: { signal?: AbortSignal }
    ): Promise<PostIncidentStatusResponse> => {
        const response = await requestJson<PostIncidentStatusResponse>(
            `/api/incidents/${encodeURIComponent(incidentId)}/status`,
            {
                method: 'POST',
                headers,
                body: request,
                signal: options?.signal,
                validateResponse: createSchemaResponseValidator(
                    PostIncidentStatusResponseSchema
                ),
            }
        );

        return response.data;
    };

    /**
     * @api.operationId: postIncidentNotes
     * @api.path: POST /api/incidents/{incidentId}/notes
     */
    const addIncidentNote = async (
        incidentId: string,
        request: PostIncidentNotesRequest,
        options?: { signal?: AbortSignal }
    ): Promise<PostIncidentNotesResponse> => {
        const response = await requestJson<PostIncidentNotesResponse>(
            `/api/incidents/${encodeURIComponent(incidentId)}/notes`,
            {
                method: 'POST',
                headers,
                body: request,
                signal: options?.signal,
                validateResponse: createSchemaResponseValidator(
                    PostIncidentNotesResponseSchema
                ),
            }
        );

        return response.data;
    };

    /**
     * @api.operationId: postIncidentRemediation
     * @api.path: POST /api/incidents/{incidentId}/remediation
     */
    const recordIncidentRemediation = async (
        incidentId: string,
        request: PostIncidentRemediationRequest,
        options?: { signal?: AbortSignal }
    ): Promise<PostIncidentRemediationResponse> => {
        const response = await requestJson<PostIncidentRemediationResponse>(
            `/api/incidents/${encodeURIComponent(incidentId)}/remediation`,
            {
                method: 'POST',
                headers,
                body: request,
                signal: options?.signal,
                validateResponse: createSchemaResponseValidator(
                    PostIncidentRemediationResponseSchema
                ),
            }
        );

        return response.data;
    };

    return {
        reportIncident,
        listIncidents,
        getIncident,
        updateIncidentStatus,
        addIncidentNote,
        recordIncidentRemediation,
    };
};
