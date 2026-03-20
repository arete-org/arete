/**
 * @description: Handles trusted internal text-task requests for backend-owned non-reflect workflows.
 * @footnote-scope: interface
 * @footnote-module: InternalTextHandler
 * @footnote-risk: high - Auth or validation mistakes here could expose internal-only task execution or allow malformed task payloads.
 * @footnote-ethics: medium - This route controls how trusted callers request backend-owned text tasks and should stay narrow by design.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
    PostInternalImageDescriptionTaskRequest,
    PostInternalNewsTaskRequest,
} from '@footnote/contracts/web';
import { PostInternalTextRequestSchema } from '@footnote/contracts/web/schemas';
import type {
    InternalImageDescriptionTaskService,
    InternalNewsTaskService,
} from '../services/internalText.js';
import { SimpleRateLimiter } from '../services/rateLimiter.js';
import { logger } from '../utils/logger.js';
import { sendJson } from './reflectResponses.js';
import {
    parseTrustedBodyWithSchema,
    parseTrustedServiceAuth,
    type TrustedRouteLogRequest,
} from './trustedServiceRequest.js';

type CreateInternalTextHandlerOptions = {
    internalNewsTaskService: InternalNewsTaskService | null;
    internalImageDescriptionTaskService: InternalImageDescriptionTaskService | null;
    logRequest: TrustedRouteLogRequest;
    maxBodyBytes: number;
    traceApiToken: string | null;
    serviceToken: string | null;
    serviceRateLimiter: SimpleRateLimiter;
};

export const createInternalTextHandler = ({
    internalNewsTaskService,
    internalImageDescriptionTaskService,
    logRequest,
    maxBodyBytes,
    traceApiToken,
    serviceToken,
    serviceRateLimiter,
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

            const auth = parseTrustedServiceAuth(
                req,
                {
                    traceApiToken,
                    serviceToken,
                },
                {
                    missing: 'internal text missing-trusted-auth',
                    invalid: 'internal text invalid-trusted-auth',
                }
            );
            if (!auth.ok) {
                sendJson(res, auth.statusCode, auth.payload);
                logRequest(req, res, auth.logLabel);
                return;
            }

            const serviceRateLimitResult = serviceRateLimiter.check(
                `${auth.source}:${auth.rateLimitKey}`
            );
            if (!serviceRateLimitResult.allowed) {
                sendJson(
                    res,
                    429,
                    {
                        error: 'Too many requests from this trusted service',
                        retryAfter: serviceRateLimitResult.retryAfter,
                    },
                    {
                        'Retry-After':
                            serviceRateLimitResult.retryAfter.toString(),
                    }
                );
                logRequest(
                    req,
                    res,
                    `internal text rate-limited source=${auth.source} retryAfter=${serviceRateLimitResult.retryAfter}`
                );
                return;
            }

            if (
                !internalNewsTaskService ||
                !internalImageDescriptionTaskService
            ) {
                sendJson(res, 503, {
                    error: 'Internal text service unavailable',
                });
                logRequest(req, res, 'internal text service-unavailable');
                return;
            }

            const parsedRequest = await parseTrustedBodyWithSchema(req, res, {
                logRequest,
                routeLabel: 'internal text',
                maxBodyBytes,
                safeParse: (value) =>
                    PostInternalTextRequestSchema.safeParse(value),
            });
            if (parsedRequest === null) {
                return;
            }

            if (parsedRequest.task === 'news') {
                const newsRequest: PostInternalNewsTaskRequest = parsedRequest;
                const response =
                    await internalNewsTaskService.runNewsTask(newsRequest);
                sendJson(res, 200, response);
                logRequest(
                    req,
                    res,
                    `internal text success task=${response.task}`
                );
                return;
            }

            if (parsedRequest.task === 'image_description') {
                const imageDescriptionRequest: PostInternalImageDescriptionTaskRequest =
                    parsedRequest;
                const response =
                    await internalImageDescriptionTaskService.runImageDescriptionTask(
                        imageDescriptionRequest
                    );
                sendJson(res, 200, response);
                logRequest(
                    req,
                    res,
                    `internal text success task=${response.task}`
                );
                return;
            }

            // Alternative Lens intentionally stays out of this route for now.
            // That feature is being redesigned instead of migrated into a
            // placeholder backend task.
            const unsupportedTask = (parsedRequest as { task?: unknown }).task;
            const unsupportedTaskLabel =
                typeof unsupportedTask === 'string'
                    ? unsupportedTask
                    : 'unknown';
            sendJson(res, 400, {
                error: `Unsupported task: ${unsupportedTaskLabel}`,
            });
            logRequest(
                req,
                res,
                `internal text unsupported-task task=${unsupportedTaskLabel}`
            );
        } catch (error) {
            logger.error('Internal text task execution failed', {
                error: error instanceof Error ? error.message : String(error),
            });
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
