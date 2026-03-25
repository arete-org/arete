/**
 * @description: Handles trusted internal voice TTS requests for backend-owned speech synthesis.
 * @footnote-scope: interface
 * @footnote-module: InternalVoiceTtsHandler
 * @footnote-risk: high - Auth or validation mistakes here could expose internal-only voice synthesis.
 * @footnote-ethics: high - Voice requests carry user content and must stay within trusted boundaries.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PostInternalVoiceTtsRequest } from '@footnote/contracts/voice';
import { PostInternalVoiceTtsRequestSchema } from '@footnote/contracts/voice';
import type { InternalVoiceTtsService } from '../services/internalVoiceTts.js';
import { SimpleRateLimiter } from '../services/rateLimiter.js';
import { logger } from '../utils/logger.js';
import { sendJson } from './chatResponses.js';
import {
    parseTrustedBodyWithSchema,
    parseTrustedServiceAuth,
    type TrustedRouteLogRequest,
} from './trustedServiceRequest.js';

/**
 * @footnote-logger: internalVoiceTtsHandler
 * @logs: Auth decisions, request acceptance, and execution failures for internal TTS calls.
 * @footnote-risk: medium - Missing logs hide TTS outages or abuse; noisy logs can expose metadata volume.
 * @footnote-ethics: high - Voice requests include user content, so we log only metadata.
 */
const ttsLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'internalVoiceTtsHandler' })
        : logger;

type CreateInternalVoiceTtsHandlerOptions = {
    internalVoiceTtsService: InternalVoiceTtsService | null;
    logRequest: TrustedRouteLogRequest;
    maxBodyBytes: number;
    traceApiToken: string | null;
    serviceToken: string | null;
    serviceRateLimiter: SimpleRateLimiter;
};

export const createInternalVoiceTtsHandler = ({
    internalVoiceTtsService,
    logRequest,
    maxBodyBytes,
    traceApiToken,
    serviceToken,
    serviceRateLimiter,
}: CreateInternalVoiceTtsHandlerOptions) => {
    /**
     * @api.operationId: postInternalVoiceTts
     * @api.path: POST /api/internal/voice/tts
     */
    const handleInternalVoiceTtsRequest = async (
        req: IncomingMessage,
        res: ServerResponse
    ): Promise<void> => {
        try {
            if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'Method not allowed' });
                logRequest(req, res, 'internal voice tts method-not-allowed');
                return;
            }

            const auth = parseTrustedServiceAuth(
                req,
                {
                    traceApiToken,
                    serviceToken,
                },
                {
                    missing: 'internal voice tts missing-trusted-auth',
                    invalid: 'internal voice tts invalid-trusted-auth',
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
                ttsLogger.warn('Internal voice TTS rate limited.', {
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
                    `internal voice tts rate-limited source=${auth.source} retryAfter=${serviceRateLimitResult.retryAfter}`
                );
                return;
            }

            if (!internalVoiceTtsService) {
                ttsLogger.warn(
                    'Internal voice TTS service unavailable for request.'
                );
                sendJson(res, 503, {
                    error: 'Internal voice service unavailable',
                });
                logRequest(req, res, 'internal voice tts service-unavailable');
                return;
            }

            const parsedRequest = await parseTrustedBodyWithSchema(req, res, {
                logRequest,
                routeLabel: 'internal voice tts',
                maxBodyBytes,
                safeParse: (value) =>
                    PostInternalVoiceTtsRequestSchema.safeParse(value),
            });
            if (parsedRequest === null) {
                return;
            }

            if (parsedRequest.task !== 'synthesize') {
                ttsLogger.warn('Internal voice TTS unsupported task.', {
                    task: parsedRequest.task,
                });
                sendJson(res, 400, {
                    error: `Unsupported task: ${parsedRequest.task}`,
                });
                logRequest(
                    req,
                    res,
                    `internal voice tts unsupported-task task=${parsedRequest.task}`
                );
                return;
            }

            const ttsRequest: PostInternalVoiceTtsRequest = parsedRequest;
            ttsLogger.info('Internal voice TTS request accepted.', {
                source: auth.source,
                model: ttsRequest.options.model,
                voice: ttsRequest.options.voice,
                outputFormat: ttsRequest.outputFormat,
                textLength: ttsRequest.text.length,
            });
            const response = await internalVoiceTtsService.runTtsTask(
                ttsRequest
            );
            sendJson(res, 200, response);
            logRequest(req, res, `internal voice tts success task=${response.task}`);
        } catch (error) {
            ttsLogger.error('Internal voice TTS execution failed.', {
                error: error instanceof Error ? error.message : String(error),
            });
            sendJson(res, 502, {
                error: 'Failed to execute internal voice TTS task',
            });
            logRequest(
                req,
                res,
                `internal voice tts error ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    };

    return {
        handleInternalVoiceTtsRequest,
    };
};
