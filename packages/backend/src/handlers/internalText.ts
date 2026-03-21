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

/**
 * @footnote-logger: internalTextHandler
 * @logs: Auth decisions, task acceptance, and execution failures for internal text tasks.
 * @footnote-risk: high - Missing logs hide trusted-task regressions or abuse.
 * @footnote-ethics: medium - Text tasks can include user content, so logs stay metadata-only.
 */
const textLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'internalTextHandler' })
        : logger;

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
                textLogger.warn('Internal text rejected: auth failed.', {
                    statusCode: auth.statusCode,
                });
                sendJson(res, auth.statusCode, auth.payload);
                logRequest(req, res, auth.logLabel);
                return;
            }

            const serviceRateLimitResult = serviceRateLimiter.check(
                `${auth.source}:${auth.rateLimitKey}`
            );
            if (!serviceRateLimitResult.allowed) {
                textLogger.warn('Internal text rate limited.', {
                    source: auth.source,
                    retryAfter: serviceRateLimitResult.retryAfter,
                });
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
                if (!internalNewsTaskService) {
                    textLogger.warn('Internal text news task unavailable.');
                    sendJson(res, 503, {
                        error: 'Internal text service unavailable',
                    });
                    logRequest(req, res, 'internal text service-unavailable');
                    return;
                }

                const newsRequest: PostInternalNewsTaskRequest = parsedRequest;
                textLogger.info('Internal text news task accepted.', {
                    source: auth.source,
                    queryLength: newsRequest.query?.length ?? 0,
                    categoryLength: newsRequest.category?.length ?? 0,
                    maxResults: newsRequest.maxResults,
                    hasChannelContext: Boolean(newsRequest.channelContext),
                });
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
                if (!internalImageDescriptionTaskService) {
                    textLogger.warn('Internal text image-description task unavailable.');
                    sendJson(res, 503, {
                        error: 'Internal text service unavailable',
                    });
                    logRequest(req, res, 'internal text service-unavailable');
                    return;
                }

                const imageDescriptionRequest: PostInternalImageDescriptionTaskRequest =
                    parsedRequest;
                let imageHost: string | null = null;
                try {
                    imageHost = new URL(imageDescriptionRequest.imageUrl).hostname;
                } catch {
                    imageHost = null;
                }
                textLogger.info('Internal text image-description task accepted.', {
                    source: auth.source,
                    imageHost,
                    contextLength: imageDescriptionRequest.context?.length ?? 0,
                });
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
            textLogger.warn('Internal text unsupported task.', {
                task: unsupportedTaskLabel,
            });
            sendJson(res, 400, {
                error: `Unsupported task: ${unsupportedTaskLabel}`,
            });
            logRequest(
                req,
                res,
                `internal text unsupported-task task=${unsupportedTaskLabel}`
            );
        } catch (error) {
            textLogger.error('Internal text task execution failed.', {
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
