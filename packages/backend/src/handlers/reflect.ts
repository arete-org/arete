/**
 * @description: Handles /api/reflect requests for the public web UI and trusted
 * internal callers, then returns an AI response plus provenance metadata.
 * @footnote-scope: interface
 * @footnote-module: ReflectHandler
 * @footnote-risk: high - Failures block AI responses and provenance capture.
 * @footnote-ethics: high - Incorrect metadata harms transparency and user trust.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import { SimpleRateLimiter } from '../services/rateLimiter.js';
import type {
    OpenAIService,
    OpenAIResponseMetadata,
    ResponseMetadataRuntimeContext,
} from '../services/openaiService.js';
import { runtimeConfig } from '../config.js';
import { createReflectService } from '../services/reflectService.js';
import { logger } from '../utils/logger.js';
import {
    type ReflectAuthContext,
    resolveReflectAuth,
    verifyTurnstileCaptcha,
} from './reflectAuth.js';
import {
    getRequestIdentity,
    parseReflectRequest,
} from './reflectRequest.js';
import { createReflectRateLimitController } from './reflectRateLimit.js';
import { sendJson } from './reflectResponses.js';

type LogRequest = (
    req: IncomingMessage,
    res: ServerResponse,
    extra?: string
) => void;

type BuildResponseMetadata = (
    assistantMetadata: OpenAIResponseMetadata,
    runtimeContext: ResponseMetadataRuntimeContext
) => ResponseMetadata;

type ReflectHandlerDeps = {
    openaiService: OpenAIService | null;
    ipRateLimiter: SimpleRateLimiter | null;
    sessionRateLimiter: SimpleRateLimiter | null;
    serviceRateLimiter: SimpleRateLimiter | null;
    storeTrace: (metadata: ResponseMetadata) => Promise<void>;
    logRequest: LogRequest;
    buildResponseMetadata: BuildResponseMetadata;
    maxReflectBodyBytes: number;
};

// The handler keeps transport concerns here and pushes business logic into helpers/services.
// That split is what lets future callers reuse the reflect workflow without copying HTTP code.

/**
 * Applies credentialed CORS headers only for explicitly allowed browser origins.
 * Trusted service callers do not rely on CORS, but browsers do.
 */
const setCorsHeaders = (res: ServerResponse, req: IncomingMessage): void => {
    const allowedOrigins = runtimeConfig.cors.allowedOrigins;
    const origin = req.headers.origin;

    const sanitizedAllowedOrigins = Array.isArray(allowedOrigins)
        ? allowedOrigins.filter(
              (allowedOrigin) =>
                  typeof allowedOrigin === 'string' &&
                  allowedOrigin !== '*' &&
                  allowedOrigin.toLowerCase() !== 'null' &&
                  allowedOrigin.trim() !== ''
          )
        : [];

    const normalizedAllowedOrigins = sanitizedAllowedOrigins.map(
        (allowedOrigin) => allowedOrigin.trim().toLowerCase()
    );
    const normalizedOrigin =
        typeof origin === 'string' ? origin.trim().toLowerCase() : null;
    const allowedIndex =
        normalizedOrigin && normalizedOrigin !== 'null'
            ? normalizedAllowedOrigins.indexOf(normalizedOrigin)
            : -1;

    if (allowedIndex === -1 || !origin) {
        return;
    }

    const safeOrigin = sanitizedAllowedOrigins[allowedIndex];
    res.setHeader('Access-Control-Allow-Origin', safeOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, X-Turnstile-Token, X-Session-Id, X-Trace-Token, X-Service-Token'
    );
    res.setHeader('Access-Control-Allow-Credentials', 'true');
};

/**
 * Logs the auth outcome that was actually used for this request.
 * We keep this separate from the auth helper so the route owns request logging.
 */
const logSuccessfulAuthStep = (
    req: IncomingMessage,
    res: ServerResponse,
    logRequest: LogRequest,
    authContext: ReflectAuthContext
): void => {
    if (authContext.skipCaptcha && authContext.skipReason) {
        logger.info(`Skipping CAPTCHA verification (${authContext.skipReason})`);
        logRequest(req, res, `reflect captcha-skipped-${authContext.skipReason}`);
        return;
    }

    logRequest(req, res, `reflect captcha-verified source=${authContext.tokenSource}`);
};

/**
 * Thin HTTP adapter for the reflect workflow.
 * High-level flow:
 * 1. CORS + method guard
 * 2. Request parsing
 * 3. Auth / CAPTCHA
 * 4. Rate limiting
 * 5. Shared reflect workflow
 */
const createReflectHandler = ({
    openaiService,
    ipRateLimiter,
    sessionRateLimiter,
    serviceRateLimiter,
    storeTrace,
    logRequest,
    buildResponseMetadata,
    maxReflectBodyBytes,
}: ReflectHandlerDeps) => {
    const reflectService = openaiService
        ? createReflectService({
              openaiService,
              storeTrace,
              buildResponseMetadata,
              defaultModel: runtimeConfig.openai.defaultModel,
          })
        : null;

    // If OpenAI is unavailable, we keep the handler alive and return 503 later instead of failing startup.
    // The controller keeps public and trusted-service limiter buckets separate.
    const rateLimitController = createReflectRateLimitController({
        ipRateLimiter,
        sessionRateLimiter,
        serviceRateLimiter,
    });

    /**
     * @api.operationId: postReflect
     * @api.path: POST /api/reflect
     * @api.operationId: optionsReflect
     * @api.path: OPTIONS /api/reflect
     */
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        try {
            // Apply CORS before any early return so browsers get consistent headers on failures too.
            setCorsHeaders(res, req);

            if (req.method === 'OPTIONS') {
                // Only answer preflight when the browser supplied the fields a real preflight should have.
                const hasOrigin =
                    typeof req.headers.origin === 'string' &&
                    req.headers.origin.trim().length > 0;
                const requestedMethod =
                    req.headers['access-control-request-method'];
                const hasRequestedMethod =
                    typeof requestedMethod === 'string' &&
                    requestedMethod.trim().length > 0;

                if (!hasOrigin || !hasRequestedMethod) {
                    sendJson(res, 400, { error: 'Invalid CORS preflight' });
                    logRequest(req, res, 'reflect preflight-invalid');
                    return;
                }

                res.statusCode = 204;
                res.end();
                logRequest(req, res, 'reflect options-preflight');
                return;
            }

            if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'Method not allowed' });
                logRequest(req, res, 'reflect method-not-allowed');
                return;
            }

            // Parse and validate the body before we do any expensive auth or model work.
            const parsedRequestResult = await parseReflectRequest(
                req,
                maxReflectBodyBytes
            );
            if (!parsedRequestResult.success) {
                if (parsedRequestResult.error.logLabel === 'reflect invalid-json') {
                    logger.warn('Reflect handler received invalid JSON body.');
                }

                sendJson(
                    res,
                    parsedRequestResult.error.statusCode,
                    parsedRequestResult.error.payload,
                    parsedRequestResult.error.extraHeaders
                );
                logRequest(req, res, parsedRequestResult.error.logLabel);
                return;
            }

            // Identity is only for abuse controls. It does not grant access by itself.
            const identity = getRequestIdentity(
                req,
                process.env.WEB_TRUST_PROXY === 'true'
            );

            // Auth decides whether this caller is a trusted service or a public browser/API caller.
            const authResult = resolveReflectAuth(req);
            if (!authResult.success) {
                sendJson(
                    res,
                    authResult.error.statusCode,
                    authResult.error.payload,
                    authResult.error.extraHeaders
                );
                logRequest(req, res, authResult.error.logLabel);
                return;
            }

            // Rate limiting happens after auth so trusted services and public users land in different buckets.
            const rateLimitResult = rateLimitController.checkRateLimit(
                authResult.data.serviceAuth,
                identity
            );
            if (!rateLimitResult.success) {
                sendJson(
                    res,
                    rateLimitResult.error.statusCode,
                    rateLimitResult.error.payload,
                    rateLimitResult.error.extraHeaders
                );
                logRequest(req, res, rateLimitResult.error.logLabel);
                return;
            }

            if (!authResult.data.skipCaptcha) {
                // Trusted services skip this block. Public callers must satisfy Turnstile.
                logger.debug(
                    `Turnstile token extraction: source=${authResult.data.tokenSource}, length=${authResult.data.turnstileToken?.length || 0}`
                );

                const captchaResult = await verifyTurnstileCaptcha({
                    clientIp: identity.clientIp,
                    requestHost:
                        typeof req.headers.host === 'string'
                            ? req.headers.host
                            : undefined,
                    requestOrigin:
                        typeof req.headers.origin === 'string'
                            ? req.headers.origin
                            : undefined,
                    turnstileToken: authResult.data.turnstileToken,
                    tokenSource: authResult.data.tokenSource,
                });
                if (!captchaResult.success) {
                    sendJson(
                        res,
                        captchaResult.error.statusCode,
                        captchaResult.error.payload,
                        captchaResult.error.extraHeaders
                    );
                    logRequest(req, res, captchaResult.error.logLabel);
                    return;
                }
            }

            logSuccessfulAuthStep(req, res, logRequest, authResult.data);

            if (!reflectService) {
                sendJson(res, 503, {
                    error: 'Service temporarily unavailable. Please try again later.',
                });
                logRequest(req, res, 'reflect service-unavailable');
                return;
            }

            // From here on, the request is fully normalized and can delegate to the shared workflow.
            const reflectResponse = await reflectService.runReflect({
                question: parsedRequestResult.data.question,
            });
            sendJson(res, 200, reflectResponse);
            logRequest(
                req,
                res,
                `reflect success questionLength=${parsedRequestResult.data.question.length}`
            );
        } catch (openaiError) {
            const errorMessage =
                openaiError instanceof Error
                    ? openaiError.message
                    : String(openaiError);

            sendJson(res, 502, {
                error: 'AI generation failed',
            });
            logRequest(
                req,
                res,
                `reflect openai-error ${errorMessage}`
            );
        }
    };
};

export { createReflectHandler };
