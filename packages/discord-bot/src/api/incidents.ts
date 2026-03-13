/**
 * @description: Incident endpoint methods for Discord bot backend integration.
 * @footnote-scope: utility
 * @footnote-module: DiscordIncidentApi
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

/**
 * Thin typed client used by the Discord bot to call the backend incident APIs.
 */
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

/**
 * Builds the trusted-service headers expected by the backend. The bot only
 * sends `X-Trace-Token` today, but this keeps auth header creation in one
 * place.
 */
const buildTrustedHeaders = (traceApiToken?: string): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (traceApiToken) {
        headers['X-Trace-Token'] = traceApiToken;
    }
    return headers;
};

/**
 * Converts optional list filters into the query string used by `GET
 * /api/incidents`.
 */
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
    if (filters.status) {
        params.set('status', filters.status);
    }
    if (filters.tag) {
        params.set('tag', filters.tag);
    }
    if (filters.createdFrom) {
        params.set('createdFrom', filters.createdFrom);
    }
    if (filters.createdTo) {
        params.set('createdTo', filters.createdTo);
    }

    const query = params.toString();
    return query ? `?${query}` : '';
};

/**
 * Creates the incident API client bound to one request function and auth
 * configuration.
 */
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
