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
import { sendJson } from './reflectResponses.js';

type LogRequest = (
    req: IncomingMessage,
    res: ServerResponse,
    extra?: string
) => void;

type IncidentHandlerDeps = {
    incidentService: IncidentService;
    logRequest: LogRequest;
    maxIncidentBodyBytes: number;
    traceApiToken: string | null;
    serviceToken: string | null;
};

/**
 * Normalizes a header into one trimmed string so auth checks do not need to
 * care whether Node exposed the header as one value or an array.
 */
const readHeaderValue = (
    headerValue: string | string[] | undefined
): string | null => {
    if (!headerValue) {
        return null;
    }

    const rawValue = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const trimmedValue = rawValue.trim();
    return trimmedValue.length > 0 ? trimmedValue : null;
};

/**
 * Applies the trusted internal auth rule for incident endpoints. We prefer the
 * dedicated service token when configured, but still allow the legacy trace
 * token so existing internal callers keep working.
 */
const parseTrustedServiceAuth = (
    req: IncomingMessage,
    {
        traceApiToken,
        serviceToken,
    }: {
        traceApiToken: string | null;
        serviceToken: string | null;
    }
): { ok: true; source: 'x-service-token' | 'x-trace-token' } | {
    ok: false;
    statusCode: number;
    payload: { error: string; details?: string };
    logLabel: string;
} => {
    const serviceHeaderValue = readHeaderValue(req.headers['x-service-token']);
    if (serviceToken && serviceHeaderValue === serviceToken) {
        return { ok: true, source: 'x-service-token' };
    }

    const traceHeaderValue = readHeaderValue(req.headers['x-trace-token']);
    if (traceApiToken && traceHeaderValue === traceApiToken) {
        return { ok: true, source: 'x-trace-token' };
    }

    if (!serviceHeaderValue && !traceHeaderValue) {
        return {
            ok: false,
            statusCode: 401,
            payload: {
                error: 'Missing trusted service credentials',
            },
            logLabel: 'incidents missing-trusted-auth',
        };
    }

    return {
        ok: false,
        statusCode: 403,
        payload: {
            error: 'Invalid trusted service credentials',
        },
        logLabel: 'incidents invalid-trusted-auth',
    };
};

/**
 * Reads one JSON body with an explicit size limit so oversized requests fail
 * quickly instead of holding the process open.
 */
const parseJsonBody = async (
    req: IncomingMessage,
    res: ServerResponse,
    logRequest: LogRequest,
    routeLabel: string,
    maxBodyBytes: number
): Promise<unknown | null> => {
    const contentLengthHeader = req.headers['content-length'];
    if (contentLengthHeader) {
        const contentLength = Number(contentLengthHeader);
        if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
            sendJson(res, 413, { error: 'Request payload too large' });
            logRequest(req, res, `${routeLabel} payload-too-large`);
            req.resume();
            return null;
        }
    }

    const chunks: Buffer[] = [];
    let bodyTooLarge = false;
    let bodyBytes = 0;
    req.on('data', (chunk) => {
        if (bodyTooLarge) {
            return;
        }
        const chunkBuffer = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk);
        bodyBytes += chunkBuffer.length;
        if (bodyBytes > maxBodyBytes) {
            bodyTooLarge = true;
            sendJson(res, 413, { error: 'Request payload too large' });
            logRequest(req, res, `${routeLabel} payload-too-large`);
            req.destroy();
            return;
        }
        chunks.push(chunkBuffer);
    });

    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            req.off('end', onEnd);
            req.off('error', onError);
            req.off('close', onClose);
            req.off('aborted', onAborted);
        };
        const onEnd = () => {
            cleanup();
            resolve();
        };
        const onError = (error: Error) => {
            cleanup();
            if (bodyTooLarge) {
                resolve();
                return;
            }
            reject(error);
        };
        const onClose = () => {
            cleanup();
            if (bodyTooLarge) {
                resolve();
                return;
            }
            reject(new Error(`${routeLabel} request closed before body completed`));
        };
        const onAborted = () => {
            cleanup();
            if (bodyTooLarge) {
                resolve();
                return;
            }
            reject(new Error(`${routeLabel} request aborted before body completed`));
        };
        req.on('end', onEnd);
        req.on('error', onError);
        req.on('close', onClose);
        req.on('aborted', onAborted);
    });

    if (bodyTooLarge) {
        return null;
    }

    const body = Buffer.concat(chunks, bodyBytes).toString('utf8');
    if (!body) {
        sendJson(res, 400, { error: 'Missing request body' });
        logRequest(req, res, `${routeLabel} missing-body`);
        return null;
    }

    try {
        return JSON.parse(body) as unknown;
    } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        logRequest(req, res, `${routeLabel} invalid-json`);
        return null;
    }
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
        safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } }
    ): Promise<T | null> => {
        const payload = await parseJsonBody(
            req,
            res,
            logRequest,
            routeLabel,
            maxIncidentBodyBytes
        );
        if (payload === null) {
            return null;
        }

        const parsed = safeParse(payload);
        if (parsed.success) {
            return parsed.data;
        }

        const firstIssue = parsed.error.issues[0];
        const issuePath =
            firstIssue && firstIssue.path.length > 0
                ? firstIssue.path.join('.')
                : 'body';
        sendJson(res, 400, {
            error: 'Invalid request payload',
            details: `${issuePath}: ${firstIssue?.message ?? 'Invalid request payload'}`,
        });
        logRequest(req, res, `${routeLabel} invalid-payload`);
        return null;
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
