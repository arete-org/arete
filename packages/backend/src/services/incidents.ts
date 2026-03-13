/**
 * @description: Coordinates backend-owned incident workflows and maps durable incident state into operator-safe API payloads.
 * @footnote-scope: core
 * @footnote-module: IncidentService
 * @footnote-risk: high - Incorrect orchestration can corrupt incident state or audit trails.
 * @footnote-ethics: high - Incident review data shapes operator trust, privacy, and remediation visibility.
 */
import type {
    GetIncidentResponse,
    GetIncidentsResponse,
    IncidentAuditEvent as ApiIncidentAuditEvent,
    IncidentDetail,
    IncidentSummary,
    PostIncidentNotesRequest,
    PostIncidentRemediationRequest,
    PostIncidentReportRequest,
    PostIncidentStatusRequest,
} from '@footnote/contracts/web';
import { logger } from '../utils/logger.js';
import type {
    IncidentAuditEvent,
    IncidentRecord,
} from '../storage/incidents/sqliteIncidentStore.js';
import type { IncidentStore } from '../storage/incidents/incidentStore.js';

const incidentServiceLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'incidentService' })
        : logger;

/**
 * Raised when callers ask for an incident short ID that does not exist.
 * Handlers translate this into a 404 for operator tooling.
 */
export class IncidentNotFoundError extends Error {
    constructor(incidentId: string) {
        super(`Incident "${incidentId}" not found`);
        this.name = 'IncidentNotFoundError';
    }
}

type CreateIncidentServiceOptions = {
    incidentStore: IncidentStore;
};

/**
 * Converts one storage audit row into the operator-safe API payload shape.
 */
const mapAuditEvent = (
    auditEvent: IncidentAuditEvent
): ApiIncidentAuditEvent => ({
    action: auditEvent.action,
    actorHash: auditEvent.actorHash ?? null,
    notes: auditEvent.notes ?? null,
    createdAt: auditEvent.createdAt,
});

/**
 * Shared summary mapping used by list and detail responses.
 */
const mapIncidentSummary = (incident: IncidentRecord): IncidentSummary => ({
    incidentId: incident.shortId,
    status: incident.status,
    tags: incident.tags,
    description: incident.description ?? null,
    contact: incident.contact ?? null,
    createdAt: incident.createdAt,
    updatedAt: incident.updatedAt,
    consentedAt: incident.consentedAt,
    pointers: incident.pointers,
    remediation: {
        state: incident.remediationState,
        applied: incident.remediationApplied,
        notes: incident.remediationNotes ?? null,
        updatedAt: incident.remediationUpdatedAt ?? null,
    },
});

/**
 * Detail responses extend the summary with the append-only audit trail.
 */
const mapIncidentDetail = (
    incident: IncidentRecord,
    auditEvents: IncidentAuditEvent[]
): IncidentDetail => ({
    ...mapIncidentSummary(incident),
    auditEvents: auditEvents.map(mapAuditEvent),
});

/**
 * Adds a compact note to `incident.created` so reviewers can immediately see
 * whether extra context was supplied.
 */
const buildIncidentCreatedAuditNotes = (
    request: PostIncidentReportRequest
): string | null => {
    const parts = [
        request.description?.trim() ? 'description provided' : null,
        request.contact?.trim() ? 'contact provided' : null,
        request.tags?.length ? `tags=${request.tags.join(', ')}` : null,
    ].filter((value): value is string => Boolean(value));

    return parts.length > 0 ? parts.join('; ') : null;
};

/**
 * Emits the canonical structured incident log events without raw Discord IDs.
 */
const logIncidentEvent = (
    eventName: string,
    incident: IncidentRecord,
    extra?: Record<string, unknown>
): void => {
    incidentServiceLogger.info(eventName, {
        event: eventName,
        incidentId: incident.shortId,
        incidentNumericId: incident.id,
        responseId: incident.pointers.responseId ?? null,
        status: incident.status,
        remediationState: incident.remediationState,
        remediationApplied: incident.remediationApplied,
        ...extra,
    });
};

/**
 * Creates the backend-owned incident workflow service. HTTP handlers and the
 * Discord bot call into this module; it owns the durable state transitions.
 */
export const createIncidentService = ({
    incidentStore,
}: CreateIncidentServiceOptions) => {
    /**
     * Resolves one incident by short ID and centralizes the not-found path.
     */
    const getIncidentRecord = async (incidentId: string): Promise<IncidentRecord> => {
        const incident = await incidentStore.getIncidentByShortId(incidentId);
        if (!incident) {
            throw new IncidentNotFoundError(incidentId);
        }
        return incident;
    };

    /**
     * Loads the full operator-safe view for one incident, including audit
     * history.
     */
    const getIncidentDetail = async (
        incidentId: string
    ): Promise<GetIncidentResponse> => {
        const incident = await getIncidentRecord(incidentId);
        const auditEvents = await incidentStore.listAuditEvents(incident.id);
        return {
            incident: mapIncidentDetail(incident, auditEvents),
        };
    };

    return {
        async reportIncident(
            request: PostIncidentReportRequest
        ): Promise<{
            incident: IncidentDetail;
            remediation: { state: 'pending' };
        }> {
            const incident = await incidentStore.createIncidentWithAudit({
                incident: {
                    reporterId: request.reporterUserId,
                    tags: request.tags,
                    description: request.description?.trim() || null,
                    contact: request.contact?.trim() || null,
                    consentedAt: request.consentedAt,
                    pointers: {
                        responseId: request.responseId,
                        guildId: request.guildId,
                        channelId: request.channelId,
                        messageId: request.messageId,
                        chainHash: request.chainHash,
                        modelVersion: request.modelVersion,
                    },
                },
                auditEvent: {
                    actorHash: request.reporterUserId,
                    action: 'incident.created',
                    notes: buildIncidentCreatedAuditNotes(request),
                },
            });

            const detail = await getIncidentDetail(incident.shortId);
            logIncidentEvent('incident.created', incident, {
                action: 'incident.created',
            });

            return {
                incident: detail.incident,
                remediation: { state: 'pending' },
            };
        },

        async listIncidents(filters: {
            status?: IncidentSummary['status'];
            tag?: string;
            createdFrom?: string;
            createdTo?: string;
        }): Promise<GetIncidentsResponse> {
            const incidents = await incidentStore.listIncidents(filters);
            return {
                incidents: incidents.map(mapIncidentSummary),
            };
        },

        async getIncident(incidentId: string): Promise<GetIncidentResponse> {
            return getIncidentDetail(incidentId);
        },

        async updateIncidentStatus(
            incidentId: string,
            request: PostIncidentStatusRequest
        ): Promise<GetIncidentResponse> {
            const incident = await getIncidentRecord(incidentId);
            const updatedIncident = await incidentStore.updateStatusWithAudit({
                incidentId: incident.id,
                status: request.status,
                auditEvent: {
                    actorHash: request.actorUserId,
                    action: 'incident.status_changed',
                    notes: request.notes?.trim() || null,
                },
            });

            logIncidentEvent('incident.status_changed', updatedIncident, {
                action: 'incident.status_changed',
            });

            return getIncidentDetail(incidentId);
        },

        async addIncidentNote(
            incidentId: string,
            request: PostIncidentNotesRequest
        ): Promise<GetIncidentResponse> {
            const incident = await getIncidentRecord(incidentId);
            await incidentStore.appendAuditEvent(incident.id, {
                actorHash: request.actorUserId,
                action: 'incident.note_added',
                notes: request.notes.trim(),
            });

            return getIncidentDetail(incidentId);
        },

        async recordIncidentRemediation(
            incidentId: string,
            request: PostIncidentRemediationRequest
        ): Promise<GetIncidentResponse> {
            const incident = await getIncidentRecord(incidentId);
            const updatedIncident =
                request.state === 'applied'
                    ? await incidentStore.updateRemediationWithAudit({
                          incidentId: incident.id,
                          remediation: {
                              state: request.state,
                              notes: request.notes?.trim() || null,
                          },
                          auditEvent: {
                              actorHash: request.actorUserId,
                              action: 'incident.remediated',
                              notes: request.notes?.trim() || null,
                          },
                      })
                    : await incidentStore.updateRemediation(incident.id, {
                          state: request.state,
                          notes: request.notes?.trim() || null,
                      });

            if (request.state === 'applied') {
                logIncidentEvent('incident.remediated', updatedIncident, {
                    action: 'incident.remediated',
                });
            }

            return getIncidentDetail(incidentId);
        },
    };
};

export type IncidentService = ReturnType<typeof createIncidentService>;
