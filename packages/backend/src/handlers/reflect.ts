/**
 * @description: Handles /api/reflect requests and dispatches AI responses with metadata.
 * @arete-scope: interface
 * @arete-module: ReflectHandler
 * @arete-risk: high - Failures block AI responses and provenance capture.
 * @arete-ethics: high - Incorrect metadata harms transparency and user trust.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SimpleRateLimiter } from '../services/rateLimiter';
import type {
  SimpleOpenAIService,
  OpenAIResponseMetadata,
  ResponseMetadataRuntimeContext
} from '../services/openaiService';
import type { ResponseMetadata } from '../ethics-core';
import { runtimeConfig } from '../config';
import { logger } from '../shared/logger';

type LogRequest = (req: IncomingMessage, res: ServerResponse, extra?: string) => void;
type BuildResponseMetadata = (
  assistantMetadata: OpenAIResponseMetadata,
  runtimeContext: ResponseMetadataRuntimeContext
) => ResponseMetadata;

type ReflectHandlerDeps = {
  openaiService: SimpleOpenAIService | null;
  ipRateLimiter: SimpleRateLimiter | null;
  sessionRateLimiter: SimpleRateLimiter | null;
  storeTrace: (metadata: ResponseMetadata) => Promise<void>;
  logRequest: LogRequest;
  buildResponseMetadata: BuildResponseMetadata;
  maxReflectBodyBytes: number;
};

const setCorsHeaders = (res: ServerResponse, req: IncomingMessage): void => {
  const allowedOrigins = runtimeConfig.cors.allowedOrigins;
  const origin = req.headers.origin;

  // Sanitize configured allowed origins: remove wildcards, "null", and falsy values.
  const sanitizedAllowedOrigins = Array.isArray(allowedOrigins)
    ? allowedOrigins.filter(
        (o) => typeof o === 'string' && o !== '*' && o.toLowerCase() !== 'null' && o.trim() !== ''
      )
    : [];

  const normalizedAllowedOrigins = sanitizedAllowedOrigins.map((allowedOrigin) =>
    allowedOrigin.trim().toLowerCase()
  );
  const normalizedOrigin = typeof origin === 'string' ? origin.trim().toLowerCase() : null;
  const allowedIndex =
    normalizedOrigin && normalizedOrigin !== 'null'
      ? normalizedAllowedOrigins.indexOf(normalizedOrigin)
      : -1;

  if (allowedIndex === -1 || !origin) {
    // No safe origin matched; omit credentialed CORS headers.
    return;
  }

  const safeOrigin = sanitizedAllowedOrigins[allowedIndex];
  res.setHeader('Access-Control-Allow-Origin', safeOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Turnstile-Token, X-Session-Id');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
};

const createReflectHandler = ({
  openaiService,
  ipRateLimiter,
  sessionRateLimiter,
  storeTrace,
  logRequest,
  buildResponseMetadata,
  maxReflectBodyBytes
}: ReflectHandlerDeps) => async (req: IncomingMessage, res: ServerResponse, parsedUrl: URL): Promise<void> => {
  try {
    // --- CORS and preflight handling ---
    setCorsHeaders(res, req);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      logRequest(req, res, 'reflect options-preflight');
      return;
    }

    // --- Method validation ---
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      logRequest(req, res, 'reflect method-not-allowed');
      return;
    }

    // --- Input parsing (query/body) ---
    let question = parsedUrl.searchParams.get('question');
    let turnstileTokenFromBody: string | null = null;

    if (req.method === 'POST') {
      try {
        let body = '';
        let bodyBytes = 0;
        let bodyTooLarge = false;

        // Enforce request size limits early to avoid buffering oversized payloads.
        const contentLengthHeader = req.headers['content-length'];
        if (contentLengthHeader) {
          const contentLength = Number(contentLengthHeader);
          if (Number.isFinite(contentLength) && contentLength > maxReflectBodyBytes) {
            res.statusCode = 413;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify({ error: 'Request payload too large' }));
            logRequest(req, res, `reflect payload-too-large contentLength=${contentLength}`);
            return;
          }
        }

        req.on('data', chunk => {
          if (bodyTooLarge) {
            return;
          }

          bodyBytes += chunk.length;
          if (bodyBytes > maxReflectBodyBytes) {
            bodyTooLarge = true;
            res.statusCode = 413;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify({ error: 'Request payload too large' }));
            logRequest(req, res, 'reflect payload-too-large');
            req.destroy();
            return;
          }

          body += chunk.toString();
        });

        await new Promise<void>((resolve, reject) => {
          req.on('end', () => resolve());
          req.on('error', reject);
        });

        if (bodyTooLarge) {
          return;
        }

        // Only parse JSON when a body is present.
        if (body) {
          const parsedBody = JSON.parse(body) as { question?: string; turnstileToken?: string };
          if (parsedBody.question) {
            question = parsedBody.question;
          }
          if (parsedBody.turnstileToken) {
            turnstileTokenFromBody = String(parsedBody.turnstileToken);
          }
        }
      } catch (error) {
        logger.warn(`Reflect handler received invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        logRequest(req, res, 'reflect invalid-json');
        return;
      }
    }

    // --- Request validation ---
    if (!question || question.trim().length === 0) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'Question parameter is required' }));
      logRequest(req, res, 'reflect missing-question');
      return;
    }

    // Limit request size to protect the model endpoint.
    const MAX_QUESTION_LENGTH = 3072;
    if (question.length > MAX_QUESTION_LENGTH) {
      res.statusCode = 413;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'Question parameter too long' }));
      logRequest(req, res, 'reflect question-too-long');
      return;
    }

    // --- CAPTCHA token extraction ---
    const hasTurnstileSecret = Boolean(process.env.TURNSTILE_SECRET_KEY);
    const hasTurnstileSite = Boolean(process.env.TURNSTILE_SITE_KEY);
    if (hasTurnstileSecret !== hasTurnstileSite) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({
        error: 'CAPTCHA verification not configured',
        details: 'TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY must both be set'
      }));
      logRequest(req, res, 'reflect captcha-misconfigured');
      return;
    }

    const skipCaptcha = !(hasTurnstileSecret && hasTurnstileSite);

    let turnstileToken: string | null = null;
    let tokenSource = 'none';

    // Prefer header tokens to avoid leaking CAPTCHA tokens in URLs.
    if (req.headers['x-turnstile-token']) {
      const headerToken = req.headers['x-turnstile-token'];
      if (Array.isArray(headerToken)) {
        turnstileToken = headerToken[0];
      } else {
        turnstileToken = String(headerToken);
      }
      tokenSource = 'header';
    }

    // Fall back to body tokens (POST clients).
    if (!turnstileToken && turnstileTokenFromBody) {
      turnstileToken = turnstileTokenFromBody;
      tokenSource = 'body';
    }

    // Query param is the least-preferred fallback for GET usage.
    if (!turnstileToken) {
      const queryToken = parsedUrl.searchParams.get('turnstileToken');
      if (queryToken) {
        turnstileToken = String(queryToken);
        tokenSource = 'query';
      }
    }

    if (!skipCaptcha) {
      logger.debug(`Turnstile token extraction: source=${tokenSource}, length=${turnstileToken?.length || 0}`);
    }

    // Enforce CAPTCHA token presence when enabled.
    if (!turnstileToken && !skipCaptcha) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'CAPTCHA token is required', details: 'Missing turnstile token' }));
      logRequest(req, res, 'reflect missing-captcha-token');
      return;
    }

    // --- Client identity (IP/session) ---
    let clientIp = req.socket.remoteAddress || 'unknown';

    const trustProxy = process.env.WEB_TRUST_PROXY === 'true';
    if (trustProxy) {
      const forwardedFor = req.headers['x-forwarded-for'];
      if (forwardedFor) {
        if (typeof forwardedFor === 'string') {
          clientIp = forwardedFor.split(',')[0].trim();
        } else if (Array.isArray(forwardedFor)) {
          clientIp = forwardedFor[0].trim();
        }
      }
    }

    if (clientIp.startsWith('::ffff:')) {
      clientIp = clientIp.substring(7);
    }

    let sessionId = parsedUrl.searchParams.get('sessionId');

    if (!sessionId) {
      const rawSessionId = req.headers['x-session-id'];
      if (rawSessionId) {
        let sessionIdStr = Array.isArray(rawSessionId) ? rawSessionId[0] : String(rawSessionId);
        sessionIdStr = sessionIdStr.trim().substring(0, 128);
        sessionIdStr = sessionIdStr.replace(/[^a-zA-Z0-9\-_]/g, '');
        if (sessionIdStr.length > 0) {
          sessionId = sessionIdStr;
        }
      }
    }

    // Default session to IP when no session header is supplied.
    if (!sessionId) {
      sessionId = `ip-${clientIp}`;
    }

    try {
      // --- CAPTCHA verification ---
      if (skipCaptcha) {
        const reason = !process.env.TURNSTILE_SECRET_KEY ? 'not-configured' : 'dev-mode';
        logger.info(`Skipping CAPTCHA verification (${reason})`);
        logRequest(req, res, `reflect captcha-skipped-${reason}`);
      } else {
        logger.debug('CAPTCHA verification debug:');
        logger.debug(`  Token source: ${tokenSource}`);
        logger.debug(`  Token length: ${turnstileToken?.length || 0}`);
        logger.debug(`  Secret key is set: ${!!process.env.TURNSTILE_SECRET_KEY}`);

        // Fail fast on missing token.
        if (!turnstileToken || turnstileToken.trim().length === 0) {
          logger.error('CAPTCHA verification attempted without a token');
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({
            error: 'CAPTCHA token is required',
            details: 'Missing turnstile token'
          }));
          logRequest(req, res, 'reflect missing-captcha-token');
          return;
        }

        // Do not attempt verification without a secret key.
        if (!process.env.TURNSTILE_SECRET_KEY) {
          logger.error('CAPTCHA verification attempted without secret key');
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({
            error: 'CAPTCHA verification not configured',
            details: 'TURNSTILE_SECRET_KEY is not set'
          }));
          logRequest(req, res, 'reflect captcha-not-configured');
          return;
        }

        // Build the Turnstile verification request.
        const formData = new URLSearchParams();
        formData.append('secret', process.env.TURNSTILE_SECRET_KEY);
        formData.append('response', turnstileToken);
        formData.append('remoteip', clientIp);

        // Abort the request if it hangs.
        let abortSignal: AbortSignal;
        try {
          abortSignal = AbortSignal.timeout(10000);
        } catch {
          const controller = new AbortController();
          setTimeout(() => controller.abort(), 10000);
          abortSignal = controller.signal;
        }

        // --- Verification request ---
        const verificationResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData.toString(),
          signal: abortSignal
        });

        // --- Upstream error handling ---
        // Handle errors returned by Turnstile.
        if (!verificationResponse.ok) {
          const errorText = await verificationResponse.text().catch(() => 'Unable to read error response');
          logger.error(`Turnstile verification service error: ${verificationResponse.status} ${verificationResponse.statusText}`);
          logger.error(`Error response body: ${errorText}`);

          let errorDetails: { 'error-codes'?: string[] };
          try {
            errorDetails = JSON.parse(errorText) as { 'error-codes'?: string[] };
          } catch {
            errorDetails = { 'error-codes': ['unknown-error'] };
          }

          const errorCodes = errorDetails['error-codes'] || [];

          if (errorCodes.includes('invalid-input-secret') || errorCodes.includes('missing-input-secret')) {
            logger.error('CAPTCHA configuration error: Secret key is invalid or does not match site key');
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify({
              error: 'CAPTCHA verification failed',
              details: 'Invalid CAPTCHA configuration. Secret key does not match site key.'
            }));
            logRequest(req, res, `reflect captcha-config-error codes=${errorCodes.join(',')}`);
            return;
          }

          throw new Error(`Verification service returned ${verificationResponse.status}: ${errorText}`);
        }

        // --- Response parsing ---
        const verificationData = await verificationResponse.json() as {
          success?: boolean;
          hostname?: string;
          'error-codes'?: string[];
          'challenge-ts'?: string;
        };

        logger.debug(`Turnstile verification response: ${JSON.stringify(verificationData, null, 2)}`);

        // --- Validation ---
        // Reject invalid CAPTCHA responses.
        if (!verificationData.success) {
          const errorCodes = verificationData['error-codes'] || [];
          const errorCodesStr = errorCodes.join(', ') || 'Unknown verification error';

          logger.error('CAPTCHA verification FAILED:');
          logger.error(`  Error codes: ${errorCodesStr}`);
          logger.error(`  Token source: ${tokenSource}`);
          logger.error(`  Token length: ${turnstileToken?.length || 0}`);
          logger.error(`  Challenge timestamp: ${verificationData['challenge-ts'] || 'N/A'}`);
          logger.error(`  Hostname from response: ${verificationData.hostname || 'N/A'}`);
          logger.error(`  Request hostname: ${req.headers.host || 'N/A'}`);
          logger.error(`  Request origin: ${req.headers.origin || 'N/A'}`);

          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({
            error: 'CAPTCHA verification failed',
            details: errorCodesStr
          }));
          logRequest(req, res, `reflect captcha-failed source=${tokenSource} errors=${errorCodesStr}`);
          return;
        }

        logger.info(`CAPTCHA verification SUCCESS for token from ${tokenSource}`);
        logger.info(`  Hostname verified: ${verificationData.hostname || 'N/A'}`);
        logger.info(`  Expected hostname: ${req.headers.host || 'N/A'}`);
        logger.info(`  Challenge timestamp: ${verificationData['challenge-ts'] || 'N/A'}`);
        logRequest(req, res, `reflect captcha-verified source=${tokenSource}`);
      }
    } catch (error) {
      // Return a 502 for upstream verification failures.
      logger.error('=== CAPTCHA Verification Error ===');
      logger.error(`Error type: ${(error as Error)?.constructor?.name ?? 'unknown'}`);
      logger.error(`Error message: ${error instanceof Error ? error.message : String(error)}`);
      logger.error(`Error stack: ${error instanceof Error ? error.stack : 'N/A'}`);
      logger.error(`Token was present: ${!!turnstileToken}`);
      logger.error(`Token length: ${turnstileToken?.length || 0}`);
      logger.error(`Secret key configured: ${!!process.env.TURNSTILE_SECRET_KEY}`);

      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({
        error: 'CAPTCHA verification service unavailable',
        details: 'Please try again later.'
      }));
      logRequest(req, res, 'reflect captcha-service-error');
      return;
    }

    // --- Rate limiting ---
    // Fail open when rate limiters are unavailable so we do not block traffic.
    const getLimiter = (
      limiter: SimpleRateLimiter | null,
      label: string,
      limitKey: string,
      windowKey: string,
      defaultLimit: number,
      defaultWindowMs: number
    ): SimpleRateLimiter => {
      if (limiter) {
        return limiter;
      }

      logger.warn(`Rate limiter "${label}" missing; creating a fallback limiter.`);
      const limitRaw = process.env[limitKey];
      const windowRaw = process.env[windowKey];
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : defaultLimit;
      const windowMs = windowRaw ? Number.parseInt(windowRaw, 10) : defaultWindowMs;
      return new SimpleRateLimiter({
        limit: Number.isFinite(limit) && limit > 0 ? limit : defaultLimit,
        window: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : defaultWindowMs
      });
    };

    const activeIpRateLimiter = getLimiter(
      ipRateLimiter,
      'ip',
      'WEB_API_RATE_LIMIT_IP',
      'WEB_API_RATE_LIMIT_IP_WINDOW_MS',
      3,
      60000
    );
    const activeSessionRateLimiter = getLimiter(
      sessionRateLimiter,
      'session',
      'WEB_API_RATE_LIMIT_SESSION',
      'WEB_API_RATE_LIMIT_SESSION_WINDOW_MS',
      5,
      60000
    );

    const ipRateLimitResult = activeIpRateLimiter.check(clientIp);
    if (!ipRateLimitResult.allowed) {
      res.statusCode = 429;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', ipRateLimitResult.retryAfter.toString());
      res.end(JSON.stringify({
        error: 'Too many requests from this IP',
        retryAfter: ipRateLimitResult.retryAfter
      }));
      logRequest(req, res, `reflect ip-rate-limited retryAfter=${ipRateLimitResult.retryAfter}`);
      return;
    }

    const sessionRateLimitResult = activeSessionRateLimiter.check(sessionId);
    if (!sessionRateLimitResult.allowed) {
      res.statusCode = 429;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', sessionRateLimitResult.retryAfter.toString());
      res.end(JSON.stringify({
        error: 'Too many requests for this session',
        retryAfter: sessionRateLimitResult.retryAfter
      }));
      logRequest(req, res, `reflect session-rate-limited retryAfter=${sessionRateLimitResult.retryAfter}`);
      return;
    }

    // --- AI request + response handling ---
    try {
      if (!openaiService) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
          error: 'Service temporarily unavailable. Please try again later.'
        }));
        logRequest(req, res, 'reflect service-unavailable');
        return;
      }

      const systemPrompt = `You are Arete, an AI assistant that helps people think through tough questions while staying honest and fair. You explore multiple ethical perspectives, trace your sources, and show how you reach your conclusions. Be helpful, thoughtful, and transparent in your responses.

RESPONSE METADATA PAYLOAD
After your conversational reply, leave a blank line and append a single JSON object on its own line prefixed with <ARETE_METADATA>.
This metadata records provenance and confidence for downstream systems.

Required fields:
  - provenance: one of "Retrieved", "Inferred", or "Speculative"
  - confidence: floating-point certainty between 0.0 and 1.0 (e.g., 0.85)
  - tradeoffCount: integer >= 0 capturing how many value tradeoffs you surfaced (use 0 if none)
  - citations: array of {"title": string, "url": fully-qualified URL, "snippet"?: string} objects (use [] if none)

Example:
<ARETE_METADATA>{"provenance":"Retrieved","confidence":0.78,"tradeoffCount":1,"citations":[{"title":"Example","url":"https://example.com"}]}

Guidelines:
  - Emit valid, minified JSON (no comments, no code fences, no trailing text)
  - Always include the <ARETE_METADATA> block after every response
  - Use "Inferred" for reasoning-based answers, "Retrieved" for fact-based, "Speculative" for uncertain answers`;

      // Assemble OpenAI messages with a system prompt + user question.
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question.trim() }
      ];

      // Dispatch the request to OpenAI.
      const aiResponse = await openaiService.generateResponse(
        runtimeConfig.openai.defaultModel,
        messages
      );

      const { normalizedText, metadata: assistantMetadata } = aiResponse;

      // Build the response metadata that will be persisted as a trace.
      const runtimeContext: ResponseMetadataRuntimeContext = {
        modelVersion: runtimeConfig.openai.defaultModel,
        conversationSnapshot: `${question}\n\n${normalizedText}`
      };

      const responseMetadata = buildResponseMetadata(
        assistantMetadata,
        runtimeContext
      );

      logger.debug('=== Server Metadata Debug ===');
      logger.debug(`Assistant metadata: ${JSON.stringify(assistantMetadata, null, 2)}`);
      logger.debug(`Assistant metadata confidence: ${(assistantMetadata as { confidence?: number })?.confidence}`);
      logger.debug(`Built response metadata: ${JSON.stringify(responseMetadata, null, 2)}`);
      logger.debug(`Response metadata confidence: ${(responseMetadata as { confidence?: number }).confidence}`);
      logger.debug('================================');

      // Persist trace in the background to avoid blocking responses.
      storeTrace(responseMetadata).catch(err => {
        logger.error(`Background trace storage error: ${err instanceof Error ? err.message : String(err)}`);
      });

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      // Return the response to the client.
      res.end(JSON.stringify({
        message: normalizedText,
        metadata: responseMetadata
      }));
      logRequest(req, res, `reflect success questionLength=${question.length}`);
    } catch (openaiError) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');

      const errorResponse = {
        error: 'AI generation failed',
        details: openaiError instanceof Error ? openaiError.message : 'Unknown OpenAI error'
      };

      res.end(JSON.stringify(errorResponse));
      logRequest(req, res, `reflect openai-error ${openaiError instanceof Error ? openaiError.message : 'unknown error'}`);
    }
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    const errorResponse = {
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error'
    };

    res.end(JSON.stringify(errorResponse));
    logRequest(req, res, `reflect error ${error instanceof Error ? error.message : 'unknown error'}`);
  }
};

export { createReflectHandler };


