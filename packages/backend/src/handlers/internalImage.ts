/**
 * @description: Handles trusted internal image-task requests for backend-owned image workflows.
 * @footnote-scope: interface
 * @footnote-module: InternalImageHandler
 * @footnote-risk: high - Auth or validation mistakes here could expose internal-only image execution or allow malformed task payloads.
 * @footnote-ethics: medium - This route controls how trusted callers request backend-owned image tasks and should stay narrow by design.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
    InternalImageErrorEvent,
    InternalImagePartialImageEvent,
    PostInternalImageGenerateRequest,
} from '@footnote/contracts/web';
import {
    InternalImageStreamEventSchema,
    PostInternalImageRequestSchema,
} from '@footnote/contracts/web/schemas';
import type { InternalImageTaskService } from '../services/internalImage.js';
import { SimpleRateLimiter } from '../services/rateLimiter.js';
import { logger } from '../utils/logger.js';
import { sendJson } from './reflectResponses.js';
import {
    parseTrustedBodyWithSchema,
    parseTrustedServiceAuth,
    type TrustedRouteLogRequest,
} from './trustedServiceRequest.js';

type CreateInternalImageHandlerOptions = {
    internalImageTaskService: InternalImageTaskService | null;
    logRequest: TrustedRouteLogRequest;
    maxBodyBytes: number;
    traceApiToken: string | null;
    serviceToken: string | null;
    serviceRateLimiter: SimpleRateLimiter;
};

const writeStreamEvent = (
    res: ServerResponse,
    event:
        | InternalImagePartialImageEvent
        | InternalImageErrorEvent
        | {
              type: 'result';
              task: 'generate';
              result: Awaited<
                  ReturnType<InternalImageTaskService['runImageTask']>
              >['result'];
          }
): void => {
    const parsed = InternalImageStreamEventSchema.safeParse(event);
    if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        throw new Error(
            `Invalid internal image stream event: ${firstIssue?.path.join('.') ?? 'body'} ${firstIssue?.message ?? 'Invalid event'}`
        );
    }

    res.write(`${JSON.stringify(parsed.data)}\n`);
};

export const createInternalImageHandler = ({
    internalImageTaskService,
    logRequest,
    maxBodyBytes,
    traceApiToken,
    serviceToken,
    serviceRateLimiter,
}: CreateInternalImageHandlerOptions) => {
    /**
     * @api.operationId: postInternalImageTask
     * @api.path: POST /api/internal/image
     */
    const handleInternalImageRequest = async (
        req: IncomingMessage,
        res: ServerResponse
    ): Promise<void> => {
        let streamStarted = false;
        try {
            if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'Method not allowed' });
                logRequest(req, res, 'internal image method-not-allowed');
                return;
            }

            const auth = parseTrustedServiceAuth(
                req,
                {
                    traceApiToken,
                    serviceToken,
                },
                {
                    missing: 'internal image missing-trusted-auth',
                    invalid: 'internal image invalid-trusted-auth',
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
                    `internal image rate-limited source=${auth.source} retryAfter=${serviceRateLimitResult.retryAfter}`
                );
                return;
            }

            if (!internalImageTaskService) {
                sendJson(res, 503, {
                    error: 'Internal image service unavailable',
                });
                logRequest(req, res, 'internal image service-unavailable');
                return;
            }

            const parsedRequest = await parseTrustedBodyWithSchema(req, res, {
                logRequest,
                routeLabel: 'internal image',
                maxBodyBytes,
                safeParse: (value) =>
                    PostInternalImageRequestSchema.safeParse(value),
            });
            if (parsedRequest === null) {
                return;
            }

            if (parsedRequest.task === 'generate') {
                const imageRequest: PostInternalImageGenerateRequest =
                    parsedRequest;
                if (imageRequest.stream) {
                    streamStarted = true;
                    res.statusCode = 200;
                    res.setHeader(
                        'Content-Type',
                        'application/x-ndjson; charset=utf-8'
                    );
                    res.setHeader('Cache-Control', 'no-store');
                    res.setHeader('X-Accel-Buffering', 'no');
                    if (typeof res.flushHeaders === 'function') {
                        res.flushHeaders();
                    }

                    const response =
                        await internalImageTaskService.runImageTask(
                            imageRequest,
                            {
                                onPartialImage: async (event) => {
                                    writeStreamEvent(res, event);
                                },
                            }
                        );
                    writeStreamEvent(res, {
                        type: 'result',
                        task: response.task,
                        result: response.result,
                    });
                    res.end();
                    logRequest(
                        req,
                        res,
                        `internal image stream-success task=${response.task}`
                    );
                    return;
                }

                const response =
                    await internalImageTaskService.runImageTask(imageRequest);
                sendJson(res, 200, response);
                logRequest(
                    req,
                    res,
                    `internal image success task=${response.task}`
                );
                return;
            }

            sendJson(res, 400, {
                error: `Unsupported task: ${parsedRequest.task}`,
            });
            logRequest(
                req,
                res,
                `internal image unsupported-task task=${parsedRequest.task}`
            );
        } catch (error) {
            logger.error('Internal image task execution failed', {
                error: error instanceof Error ? error.message : String(error),
            });
            if (streamStarted) {
                try {
                    writeStreamEvent(res, {
                        type: 'error',
                        error: 'Failed to execute internal image task',
                    });
                } catch (streamWriteError) {
                    logger.error('Internal image stream error write failed', {
                        error:
                            streamWriteError instanceof Error
                                ? streamWriteError.message
                                : String(streamWriteError),
                    });
                }
                res.end();
                logRequest(req, res, 'internal image stream-error');
                return;
            }
            sendJson(res, 502, {
                error: 'Failed to execute internal image task',
            });
            logRequest(
                req,
                res,
                `internal image error ${error instanceof Error ? error.message : String(error)}`
            );
        }
    };

    return {
        handleInternalImageRequest,
    };
};
