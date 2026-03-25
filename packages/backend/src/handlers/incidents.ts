/**
 * @description: Handles trusted internal incident report and review endpoints.
 * @footnote-scope: interface
 * @footnote-module: IncidentHandlers
 * @footnote-risk: high - Auth or validation failures can corrupt incident state or expose internal workflows.
 * @footnote-ethics: high - Incident endpoints govern privacy-sensitive reports and operator review data.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
    PostIncidentNotesRequest,
    PostIncidentRemediationRequest,
    PostIncidentReportRequest,
    PostIncidentStatusRequest,
} from '@footnote/contracts/web';
import {
    PostIncidentNotesRequestSchema,
    PostIncidentRemediationRequestSchema,
    PostIncidentReportRequestSchema,
    PostIncidentStatusRequestSchema,
} from '@footnote/contracts/web/schemas';
import type { IncidentService } from '../services/incidents.js';
import { IncidentNotFoundError } from '../services/incidents.js';
import { sendJson } from './chatResponses.js';
import {
    parseTrustedBodyWithSchema,
    parseTrustedServiceAuth,
    type TrustedRouteLogRequest,
} from './trustedServiceRequest.js';

type IncidentHandlerDeps = {
    incidentService: IncidentService;
    logRequest: TrustedRouteLogRequest;
    maxIncidentBodyBytes: number;
    traceApiToken: string | null;
    serviceToken: string | null;
};

/**
 * Accepts an ISO-style date string and returns a canonical ISO timestamp.
 * Invalid dates become `null` so callers can turn them into a clean 400.
 */
const parseOptionalDate = (value: string | null): string | null => {
    if (!value) {
        return null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const VALID_INCIDENT_STATUSES = new Set<PostIncidentStatusRequest['status']>([
    'new',
    'under_review',
    'confirmed',
    'dismissed',
    'resolved',
]);

/**
 * Builds the trusted internal HTTP handlers for incident report and review
 * routes. Each handler keeps auth, validation, and transport errors local so
 * the service layer can focus on state transitions.
 */
export const createIncidentHandlers = ({
    incidentService,
    logRequest,
    maxIncidentBodyBytes,
    traceApiToken,
    serviceToken,
}: IncidentHandlerDeps) => {
    const requireTrustedAuth = (
        req: IncomingMessage,
        res: ServerResponse
    ): boolean => {
        const auth = parseTrustedServiceAuth(req, {
            traceApiToken,
            serviceToken,
        }, {
            missing: 'incidents missing-trusted-auth',
            invalid: 'incidents invalid-trusted-auth',
        });
        if (auth.ok) {
            return true;
        }

        sendJson(res, auth.statusCode, auth.payload);
        logRequest(req, res, auth.logLabel);
        return false;
    };

    const parseBodyWithSchema = async <T>(
        req: IncomingMessage,
        res: ServerResponse,
        routeLabel: string,
        safeParse: (value: unknown) =>
            | { success: true; data: T }
            | {
                  success: false;
                  error: {
                      issues: Array<{ path: PropertyKey[]; message: string }>;
                  };
              }
    ): Promise<T | null> => {
        return parseTrustedBodyWithSchema(req, res, {
            logRequest,
            routeLabel,
            maxBodyBytes: maxIncidentBodyBytes,
            safeParse,
        });
    };

    /**
     * @api.operationId: postIncidentReport
     * @api.path: POST /api/incidents/report
     */
    const handleIncidentReportRequest = async (
        req: IncomingMessage,
        res: ServerResponse
    ): Promise<void> => {
        try {
            if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'Method not allowed' });
                logRequest(req, res, 'incident report method-not-allowed');
                return;
            }
            if (!requireTrustedAuth(req, res)) {
                return;
            }

            const payload = await parseBodyWithSchema<PostIncidentReportRequest>(
                req,
                res,
                'incident report',
                (value) => PostIncidentReportRequestSchema.safeParse(value)
            );
            if (!payload) {
                return;
            }

            const response = await incidentService.reportIncident(payload);
            sendJson(res, 200, response);
            logRequest(
                req,
                res,
                `incident report success id=${response.incident.incidentId}`
            );
        } catch (error) {
            sendJson(res, 500, { error: 'Failed to create incident report' });
            logRequest(
                req,
                res,
                `incident report error ${error instanceof Error ? error.message : String(error)}`
            );
        }
    };

    /**
     * @api.operationId: listIncidents
     * @api.path: GET /api/incidents
     */
    const handleIncidentListRequest = async (
        req: IncomingMessage,
        res: ServerResponse,
        parsedUrl: URL
    ): Promise<void> => {
        try {
            if (req.method !== 'GET') {
                sendJson(res, 405, { error: 'Method not allowed' });
                logRequest(req, res, 'incident list method-not-allowed');
                return;
            }
            if (!requireTrustedAuth(req, res)) {
                return;
            }

            const rawStatus = parsedUrl.searchParams.get('status');
            if (
                rawStatus &&
                !VALID_INCIDENT_STATUSES.has(
                    rawStatus as PostIncidentStatusRequest['status']
                )
            ) {
                sendJson(res, 400, {
                    error: 'Invalid request payload',
                    details: 'status: Expected a valid incident status',
                });
                logRequest(req, res, 'incident list invalid-status');
                return;
            }

            const createdFrom = parseOptionalDate(
                parsedUrl.searchParams.get('createdFrom')
            );
            const createdTo = parseOptionalDate(
                parsedUrl.searchParams.get('createdTo')
            );
            if (
                parsedUrl.searchParams.get('createdFrom') &&
                !createdFrom
            ) {
                sendJson(res, 400, {
                    error: 'Invalid request payload',
                    details: 'createdFrom: Expected a valid ISO date string',
                });
                logRequest(req, res, 'incident list invalid-createdFrom');
                return;
            }
            if (parsedUrl.searchParams.get('createdTo') && !createdTo) {
                sendJson(res, 400, {
                    error: 'Invalid request payload',
                    details: 'createdTo: Expected a valid ISO date string',
                });
                logRequest(req, res, 'incident list invalid-createdTo');
                return;
            }

            const response = await incidentService.listIncidents({
                status:
                    (rawStatus as PostIncidentStatusRequest['status'] | null) ??
                    undefined,
                tag: parsedUrl.searchParams.get('tag') ?? undefined,
                createdFrom: createdFrom ?? undefined,
                createdTo: createdTo ?? undefined,
            });

            sendJson(res, 200, response);
            logRequest(req, res, `incident list success count=${response.incidents.length}`);
        } catch (error) {
            sendJson(res, 500, { error: 'Failed to list incidents' });
            logRequest(
                req,
                res,
                `incident list error ${error instanceof Error ? error.message : String(error)}`
            );
        }
    };

    const readIncidentIdFromPath = (
        pathname: string,
        suffix?: string
    ):
        | { ok: true; incidentId: string }
        | { ok: false; reason: 'invalid-format' | 'invalid-encoding' } => {
        const pattern = suffix
            ? new RegExp(`^/api/incidents/([^/]+)/${suffix}/?$`)
            : /^\/api\/incidents\/([^/]+)\/?$/;
        const match = pathname.match(pattern);
        if (!match) {
            return { ok: false, reason: 'invalid-format' };
        }
        try {
            const incidentId = decodeURIComponent(match[1]).trim();
            return incidentId.length > 0
                ? { ok: true, incidentId }
                : { ok: false, reason: 'invalid-format' };
        } catch {
            return { ok: false, reason: 'invalid-encoding' };
        }
    };

    /**
     * @api.operationId: getIncident
     * @api.path: GET /api/incidents/{incidentId}
     */
    const handleIncidentDetailRequest = async (
        req: IncomingMessage,
        res: ServerResponse,
        parsedUrl: URL
    ): Promise<void> => {
        try {
            if (req.method !== 'GET') {
                sendJson(res, 405, { error: 'Method not allowed' });
                logRequest(req, res, 'incident detail method-not-allowed');
                return;
            }
            if (!requireTrustedAuth(req, res)) {
                return;
            }

            const incidentIdResult = readIncidentIdFromPath(parsedUrl.pathname);
            if (!incidentIdResult.ok) {
                sendJson(res, 400, { error: 'Invalid incident request format' });
                logRequest(
                    req,
                    res,
                    incidentIdResult.reason === 'invalid-encoding'
                        ? 'incident detail invalid-encoding'
                        : 'incident detail invalid-format'
                );
                return;
            }
            const incidentId = incidentIdResult.incidentId;

            const response = await incidentService.getIncident(incidentId);
            sendJson(res, 200, response);
            logRequest(req, res, `incident detail success id=${incidentId}`);
        } catch (error) {
            if (error instanceof IncidentNotFoundError) {
                sendJson(res, 404, { error: 'Incident not found' });
                logRequest(req, res, 'incident detail not-found');
                return;
            }

            sendJson(res, 500, { error: 'Failed to load incident' });
            logRequest(
                req,
                res,
                `incident detail error ${error instanceof Error ? error.message : String(error)}`
            );
        }
    };

    /**
     * @api.operationId: postIncidentStatus
     * @api.path: POST /api/incidents/{incidentId}/status
     */
    const handleIncidentStatusRequest = async (
        req: IncomingMessage,
        res: ServerResponse,
        parsedUrl: URL
    ): Promise<void> => {
        try {
            if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'Method not allowed' });
                logRequest(req, res, 'incident status method-not-allowed');
                return;
            }
            if (!requireTrustedAuth(req, res)) {
                return;
            }

            const incidentIdResult = readIncidentIdFromPath(
                parsedUrl.pathname,
                'status'
            );
            if (!incidentIdResult.ok) {
                sendJson(res, 400, { error: 'Invalid incident request format' });
                logRequest(
                    req,
                    res,
                    incidentIdResult.reason === 'invalid-encoding'
                        ? 'incident status invalid-encoding'
                        : 'incident status invalid-format'
                );
                return;
            }
            const incidentId = incidentIdResult.incidentId;

            const payload = await parseBodyWithSchema<PostIncidentStatusRequest>(
                req,
                res,
                'incident status',
                (value) => PostIncidentStatusRequestSchema.safeParse(value)
            );
            if (!payload) {
                return;
            }

            const response = await incidentService.updateIncidentStatus(
                incidentId,
                payload
            );
            sendJson(res, 200, response);
            logRequest(req, res, `incident status success id=${incidentId}`);
        } catch (error) {
            if (error instanceof IncidentNotFoundError) {
                sendJson(res, 404, { error: 'Incident not found' });
                logRequest(req, res, 'incident status not-found');
                return;
            }

            sendJson(res, 500, { error: 'Failed to update incident status' });
            logRequest(
                req,
                res,
                `incident status error ${error instanceof Error ? error.message : String(error)}`
            );
        }
    };

    /**
     * @api.operationId: postIncidentNotes
     * @api.path: POST /api/incidents/{incidentId}/notes
     */
    const handleIncidentNotesRequest = async (
        req: IncomingMessage,
        res: ServerResponse,
        parsedUrl: URL
    ): Promise<void> => {
        try {
            if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'Method not allowed' });
                logRequest(req, res, 'incident notes method-not-allowed');
                return;
            }
            if (!requireTrustedAuth(req, res)) {
                return;
            }

            const incidentIdResult = readIncidentIdFromPath(
                parsedUrl.pathname,
                'notes'
            );
            if (!incidentIdResult.ok) {
                sendJson(res, 400, { error: 'Invalid incident request format' });
                logRequest(
                    req,
                    res,
                    incidentIdResult.reason === 'invalid-encoding'
                        ? 'incident notes invalid-encoding'
                        : 'incident notes invalid-format'
                );
                return;
            }
            const incidentId = incidentIdResult.incidentId;

            const payload = await parseBodyWithSchema<PostIncidentNotesRequest>(
                req,
                res,
                'incident notes',
                (value) => PostIncidentNotesRequestSchema.safeParse(value)
            );
            if (!payload) {
                return;
            }

            const response = await incidentService.addIncidentNote(
                incidentId,
                payload
            );
            sendJson(res, 200, response);
            logRequest(req, res, `incident notes success id=${incidentId}`);
        } catch (error) {
            if (error instanceof IncidentNotFoundError) {
                sendJson(res, 404, { error: 'Incident not found' });
                logRequest(req, res, 'incident notes not-found');
                return;
            }

            sendJson(res, 500, { error: 'Failed to add incident note' });
            logRequest(
                req,
                res,
                `incident notes error ${error instanceof Error ? error.message : String(error)}`
            );
        }
    };

    /**
     * @api.operationId: postIncidentRemediation
     * @api.path: POST /api/incidents/{incidentId}/remediation
     */
    const handleIncidentRemediationRequest = async (
        req: IncomingMessage,
        res: ServerResponse,
        parsedUrl: URL
    ): Promise<void> => {
        try {
            if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'Method not allowed' });
                logRequest(req, res, 'incident remediation method-not-allowed');
                return;
            }
            if (!requireTrustedAuth(req, res)) {
                return;
            }

            const incidentIdResult = readIncidentIdFromPath(
                parsedUrl.pathname,
                'remediation'
            );
            if (!incidentIdResult.ok) {
                sendJson(res, 400, { error: 'Invalid incident request format' });
                logRequest(
                    req,
                    res,
                    incidentIdResult.reason === 'invalid-encoding'
                        ? 'incident remediation invalid-encoding'
                        : 'incident remediation invalid-format'
                );
                return;
            }
            const incidentId = incidentIdResult.incidentId;

            const payload =
                await parseBodyWithSchema<PostIncidentRemediationRequest>(
                    req,
                    res,
                    'incident remediation',
                    (value) => PostIncidentRemediationRequestSchema.safeParse(value)
                );
            if (!payload) {
                return;
            }

            const response = await incidentService.recordIncidentRemediation(
                incidentId,
                payload
            );
            sendJson(res, 200, response);
            logRequest(req, res, `incident remediation success id=${incidentId}`);
        } catch (error) {
            if (error instanceof IncidentNotFoundError) {
                sendJson(res, 404, { error: 'Incident not found' });
                logRequest(req, res, 'incident remediation not-found');
                return;
            }

            sendJson(res, 500, { error: 'Failed to record incident remediation' });
            logRequest(
                req,
                res,
                `incident remediation error ${error instanceof Error ? error.message : String(error)}`
            );
        }
    };

    return {
        handleIncidentReportRequest,
        handleIncidentListRequest,
        handleIncidentDetailRequest,
        handleIncidentStatusRequest,
        handleIncidentNotesRequest,
        handleIncidentRemediationRequest,
    };
};
