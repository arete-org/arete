/**
 * @description: Thin compatibility wrapper around the shared incident API factory from @footnote/api-client.
 * @footnote-scope: utility
 * @footnote-module: DiscordIncidentApi
 * @footnote-risk: medium - Incident API failures can block report submission and review tooling.
 * @footnote-ethics: high - Stable incident transport is required for durable reporting and privacy-safe review.
 */
import {
    createIncidentApi as createSharedIncidentApi,
    type CreateIncidentApiOptions,
    type IncidentApi,
} from '@footnote/api-client';
import type { ApiRequester } from './client.js';

export type { CreateIncidentApiOptions, IncidentApi };

export const createIncidentApi = (
    requestJson: ApiRequester,
    { traceApiToken }: CreateIncidentApiOptions = {}
): IncidentApi => {
    const shared = createSharedIncidentApi(requestJson, { traceApiToken });

    const reportIncident: IncidentApi['reportIncident'] = (
        request,
        options
    ) => shared.reportIncident(request, options);
    const listIncidents: IncidentApi['listIncidents'] = (filters, options) =>
        shared.listIncidents(filters, options);
    const getIncident: IncidentApi['getIncident'] = (incidentId, options) =>
        shared.getIncident(incidentId, options);
    const updateIncidentStatus: IncidentApi['updateIncidentStatus'] = (
        incidentId,
        request,
        options
    ) => shared.updateIncidentStatus(incidentId, request, options);
    const addIncidentNote: IncidentApi['addIncidentNote'] = (
        incidentId,
        request,
        options
    ) => shared.addIncidentNote(incidentId, request, options);
    const recordIncidentRemediation: IncidentApi['recordIncidentRemediation'] =
        (incidentId, request, options) =>
            shared.recordIncidentRemediation(incidentId, request, options);

    return {
        reportIncident,
        listIncidents,
        getIncident,
        updateIncidentStatus,
        addIncidentNote,
        recordIncidentRemediation,
    };
};
