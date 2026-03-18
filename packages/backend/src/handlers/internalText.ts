/**
 * @description: Handles trusted internal text-task requests for backend-owned non-reflect workflows.
 * @footnote-scope: interface
 * @footnote-module: InternalTextHandler
 * @footnote-risk: high - Auth or validation mistakes here could expose internal-only task execution or allow malformed task payloads.
 * @footnote-ethics: medium - This route controls how trusted callers request backend-owned text tasks and should stay narrow by design.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PostInternalTextRequestSchema } from '@footnote/contracts/web/schemas';
import type { InternalNewsTaskService } from '../services/internalText.js';
import { sendJson } from './reflectResponses.js';
import {
    parseTrustedBodyWithSchema,
    parseTrustedServiceAuth,
    type TrustedRouteLogRequest,
} from './trustedServiceRequest.js';

type CreateInternalTextHandlerOptions = {
    internalNewsTaskService: InternalNewsTaskService | null;
    logRequest: TrustedRouteLogRequest;
    maxBodyBytes: number;
    traceApiToken: string | null;
    serviceToken: string | null;
};

export const createInternalTextHandler = ({
    internalNewsTaskService,
    logRequest,
    maxBodyBytes,
    traceApiToken,
    serviceToken,
}: CreateInternalTextHandlerOptions) => {
    /**
     * @api.operationId: postInternalTextTask
     * @api.path: POST /api/internal/text
     */
    const handleInternalTextRequest = async (
        req: IncomingMessage,
        res: ServerResponse
    ): Promise<void> => {
        try {
            if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'Method not allowed' });
                logRequest(req, res, 'internal text method-not-allowed');
                return;
            }

            const auth = parseTrustedServiceAuth(req, {
                traceApiToken,
                serviceToken,
            }, {
                missing: 'internal text missing-trusted-auth',
                invalid: 'internal text invalid-trusted-auth',
            });
            if (!auth.ok) {
                sendJson(res, auth.statusCode, auth.payload);
                logRequest(req, res, auth.logLabel);
                return;
            }

            if (!internalNewsTaskService) {
                sendJson(res, 503, {
                    error: 'Internal text service unavailable',
                });
                logRequest(req, res, 'internal text service-unavailable');
                return;
            }

            const parsedRequest = await parseTrustedBodyWithSchema(
                req,
                res,
                {
                    logRequest,
                    routeLabel: 'internal text',
                    maxBodyBytes,
                    safeParse: (value) =>
                        PostInternalTextRequestSchema.safeParse(value),
                }
            );
            if (parsedRequest === null) {
                return;
            }

            const response =
                await internalNewsTaskService.runNewsTask(parsedRequest);
            sendJson(res, 200, response);
            logRequest(req, res, `internal text success task=${response.task}`);
        } catch (error) {
            sendJson(res, 502, {
                error: 'Failed to execute internal text task',
            });
            logRequest(
                req,
                res,
                `internal text error ${error instanceof Error ? error.message : String(error)}`
            );
        }
    };

    return {
        handleInternalTextRequest,
    };
};
