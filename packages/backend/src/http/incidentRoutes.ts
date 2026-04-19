/**
 * @description: Composes trusted incident JSON routes into an explicit Express router.
 * Preserves route precedence and delegates transport logic to existing incident handlers.
 * @footnote-scope: interface
 * @footnote-module: IncidentRoutes
 * @footnote-risk: medium - Route order mistakes can misroute incident detail and sub-route requests.
 * @footnote-ethics: high - Incident transport boundaries govern sensitive report and review workflows.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import express from 'express';
import { getRequestUrl } from './requestUrl.js';

type ParsedUrlHandler = (
    req: IncomingMessage,
    res: ServerResponse,
    parsedUrl: URL
) => Promise<void>;

type RequestHandler = (
    req: IncomingMessage,
    res: ServerResponse
) => Promise<void>;

type LogRequest = (
    req: IncomingMessage,
    res: ServerResponse,
    extra?: string
) => void;

type RegisterIncidentRoutesDeps = {
    app: express.Express;
    normalizePathname: (pathname: string) => string;
    handleIncidentListRequest: ParsedUrlHandler;
    handleIncidentReportRequest: RequestHandler;
    handleIncidentStatusRequest: ParsedUrlHandler;
    handleIncidentNotesRequest: ParsedUrlHandler;
    handleIncidentRemediationRequest: ParsedUrlHandler;
    handleIncidentDetailRequest: ParsedUrlHandler;
    logRequest: LogRequest;
};

const INCIDENT_STATUS_PATH_PATTERN = /^\/api\/incidents\/[^/]+\/status$/;
const INCIDENT_NOTES_PATH_PATTERN = /^\/api\/incidents\/[^/]+\/notes$/;
const INCIDENT_REMEDIATION_PATH_PATTERN =
    /^\/api\/incidents\/[^/]+\/remediation$/;
const INCIDENT_DETAIL_PATH_PATTERN = /^\/api\/incidents\/[^/]+$/;

const respondWithRouteError = (
    req: IncomingMessage,
    res: ServerResponse,
    logRequestWithContext: LogRequest,
    error: unknown
): void => {
    res.statusCode = 500;
    res.end('Internal Server Error');
    logRequestWithContext(
        req,
        res,
        error instanceof Error ? error.message : 'unknown error'
    );
};

/**
 * @boundary Backend transport composition boundary for incident HTTP routes.
 * @api.path: GET /api/incidents
 * @api.operationId: listIncidents
 * @route.handler: handleIncidentListRequest
 * @api.path: POST /api/incidents/report
 * @api.operationId: postIncidentReport
 * @route.handler: handleIncidentReportRequest
 * @api.path: GET /api/incidents/{incidentId}
 * @api.operationId: getIncident
 * @route.handler: handleIncidentDetailRequest
 * @api.path: POST /api/incidents/{incidentId}/status
 * @api.operationId: postIncidentStatus
 * @route.handler: handleIncidentStatusRequest
 * @api.path: POST /api/incidents/{incidentId}/notes
 * @api.operationId: postIncidentNotes
 * @route.handler: handleIncidentNotesRequest
 * @api.path: POST /api/incidents/{incidentId}/remediation
 * @api.operationId: postIncidentRemediation
 * @route.handler: handleIncidentRemediationRequest
 */
const registerIncidentRoutes = ({
    app,
    normalizePathname,
    handleIncidentListRequest,
    handleIncidentReportRequest,
    handleIncidentStatusRequest,
    handleIncidentNotesRequest,
    handleIncidentRemediationRequest,
    handleIncidentDetailRequest,
    logRequest,
}: RegisterIncidentRoutesDeps): void => {
    const incidentRouter = express.Router();
    incidentRouter.use(async (req, res, next) => {
        try {
            const requestUrl = getRequestUrl(req);
            if (!requestUrl) {
                res.status(400).end('Bad Request');
                return;
            }
            const parsedUrl = new URL(requestUrl, 'http://localhost');
            const normalizedPathname = normalizePathname(parsedUrl.pathname);

            if (normalizedPathname === '/api/incidents') {
                await handleIncidentListRequest(req, res, parsedUrl);
                return;
            }

            // Keep explicit report route before generic /api/incidents/:incidentId.
            if (normalizedPathname === '/api/incidents/report') {
                await handleIncidentReportRequest(req, res);
                return;
            }

            if (INCIDENT_STATUS_PATH_PATTERN.test(normalizedPathname)) {
                await handleIncidentStatusRequest(req, res, parsedUrl);
                return;
            }

            if (INCIDENT_NOTES_PATH_PATTERN.test(normalizedPathname)) {
                await handleIncidentNotesRequest(req, res, parsedUrl);
                return;
            }

            if (INCIDENT_REMEDIATION_PATH_PATTERN.test(normalizedPathname)) {
                await handleIncidentRemediationRequest(req, res, parsedUrl);
                return;
            }

            if (INCIDENT_DETAIL_PATH_PATTERN.test(normalizedPathname)) {
                await handleIncidentDetailRequest(req, res, parsedUrl);
                return;
            }

            next();
        } catch (error) {
            respondWithRouteError(req, res, logRequest, error);
        }
    });

    app.use('/api/incidents', incidentRouter);
};

export { registerIncidentRoutes };
