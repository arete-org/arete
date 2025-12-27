/**
 * @description: Handles trace retrieval and persistence endpoints.
 * @arete-scope: interface
 * @arete-module: TraceHandlers
 * @arete-risk: high - Trace loss undermines transparency guarantees.
 * @arete-ethics: high - Provenance access impacts user trust and auditability.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ResponseMetadata } from '../ethics-core';
import type { SimpleRateLimiter } from '../services/rateLimiter';
import { logger } from '../shared/logger';
import { assertValidResponseMetadata, type TraceStore } from '../shared/traceStore';

type LogRequest = (req: IncomingMessage, res: ServerResponse, extra?: string) => void;

type TraceHandlerDeps = {
  traceStore: TraceStore | null;
  logRequest: LogRequest;
  traceWriteLimiter: SimpleRateLimiter | null;
  traceToken: string | null;
  maxTraceBodyBytes: number;
  trustProxy: boolean;
};

// --- Client IP parsing ---
const getClientIp = (req: IncomingMessage, trustProxy: boolean): string => {
  let clientIp = req.socket.remoteAddress || 'unknown';

  // Honor reverse proxy headers only when explicitly enabled.
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

  return clientIp;
};

// --- Handler factory ---
const createTraceHandlers = ({
  traceStore,
  logRequest,
  traceWriteLimiter,
  traceToken,
  maxTraceBodyBytes,
  trustProxy
}: TraceHandlerDeps) => {
  const handleTraceRequest = async (req: IncomingMessage, res: ServerResponse, parsedUrl: URL): Promise<void> => {
    try {
      // Expect /trace/{id}.json to support trace lookups.
      const pathMatch = parsedUrl.pathname.match(/^\/trace\/(.+)\.json$/);
      if (!pathMatch) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Invalid trace request format' }));
        logRequest(req, res, 'trace invalid-format');
        return;
      }

      const responseId = pathMatch[1];

      logger.debug(`Trace request received path=${parsedUrl.pathname} responseId=${responseId}`);

      // Fail open with a 503 if storage is not available.
      if (!traceStore) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Trace store unavailable' }));
        logRequest(req, res, 'trace store-unavailable');
        return;
      }

      try {
        const metadata = await traceStore.retrieve(responseId);

        // Missing trace is not fatal but should return 404.
        if (!metadata) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'Trace not found' }));
          logRequest(req, res, 'trace not-found');
          return;
        }

        // Respect staleAfter to avoid serving expired traces.
        const staleAfter = typeof (metadata as { staleAfter?: unknown }).staleAfter === 'string'
          ? (metadata as { staleAfter?: string }).staleAfter
          : undefined;
        if (staleAfter) {
          const staleAfterDate = new Date(staleAfter);
          if (staleAfterDate < new Date()) {
            res.statusCode = 410;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ message: 'Trace is stale', metadata }));
            logRequest(req, res, 'trace stale');
            return;
          }
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(metadata));
        logRequest(req, res, 'trace success');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to retrieve trace for response "${responseId}": ${errorMessage}`);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Failed to read trace' }));
        logRequest(req, res, `trace error ${errorMessage}`);
      }
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'Internal server error' }));
      logRequest(req, res, `trace error ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  };

  const handleTraceUpsertRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // Only allow trace writes via POST.
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        logRequest(req, res, 'trace upsert method-not-allowed');
        return;
      }

      if (!traceStore) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Trace store unavailable' }));
        logRequest(req, res, 'trace upsert store-unavailable');
        return;
      }

      // Require a shared secret for trace ingestion to prevent public poisoning.
      if (!traceToken) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Trace ingestion not configured' }));
        logRequest(req, res, 'trace upsert token-not-configured');
        return;
      }

      // Validate the shared secret supplied by trusted clients (e.g., bot).
      const providedToken = req.headers['x-arete-trace-token'];
      const providedValue = Array.isArray(providedToken) ? providedToken[0] : providedToken;
      if (!providedValue) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Missing trace token' }));
        logRequest(req, res, 'trace upsert missing-token');
        return;
      }

      if (String(providedValue) !== traceToken) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Invalid trace token' }));
        logRequest(req, res, 'trace upsert invalid-token');
        return;
      }

      // Rate-limit writes per client to protect storage from abuse.
      const clientIp = getClientIp(req, trustProxy);
      if (!traceWriteLimiter) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Trace rate limiter unavailable' }));
        logRequest(req, res, 'trace upsert limiter-unavailable');
        return;
      }

      const rateLimitResult = traceWriteLimiter.check(clientIp);
      if (!rateLimitResult.allowed) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Retry-After', rateLimitResult.retryAfter.toString());
        res.end(JSON.stringify({ error: 'Too many trace writes', retryAfter: rateLimitResult.retryAfter }));
        logRequest(req, res, 'trace upsert rate-limited');
        return;
      }

      // Enforce a lightweight body size cap to avoid large payloads.
      const contentLengthHeader = req.headers['content-length'];
      if (contentLengthHeader) {
        const contentLength = Number(contentLengthHeader);
        if (Number.isFinite(contentLength) && contentLength > maxTraceBodyBytes) {
          res.statusCode = 413;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'Trace payload too large' }));
          logRequest(req, res, `trace upsert payload-too-large contentLength=${contentLength}`);
          return;
        }
      }

      let body = '';
      let bodyTooLarge = false;
      req.on('data', chunk => {
        // Track payload size as it streams in.
        body += chunk.toString();
        if (body.length > maxTraceBodyBytes) {
          bodyTooLarge = true;
          res.statusCode = 413;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'Trace payload too large' }));
          logRequest(req, res, 'trace upsert payload-too-large');
          req.destroy();
        }
      });

      await new Promise<void>((resolve, reject) => {
        req.on('end', () => resolve());
        req.on('error', reject);
      });

      if (bodyTooLarge) {
        return;
      }

      if (!body) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Missing request body' }));
        logRequest(req, res, 'trace upsert missing-body');
        return;
      }

      let payload: Record<string, unknown>;
      try {
        // --- JSON parsing ---
        payload = JSON.parse(body) as Record<string, unknown>;
      } catch (error) {
        logger.warn(`Trace upsert received invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        logRequest(req, res, 'trace upsert invalid-json');
        return;
      }

      // Normalize responseId to a canonical field.
      const responseId = (payload.responseId || payload.id) as string | undefined;
      if (!responseId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Missing responseId' }));
        logRequest(req, res, 'trace upsert missing-responseId');
        return;
      }

      // Ensure responseId is set before validation.
      const normalizedMetadata = {
        ...payload,
        responseId
      } as ResponseMetadata;

      // Validate the payload structure for trace storage.
      assertValidResponseMetadata(normalizedMetadata, 'trace upsert', responseId);

      await traceStore.upsert(normalizedMetadata);

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true, responseId }));
      logRequest(req, res, `trace upsert success ${responseId}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'unknown error';
      logger.error(`Trace upsert failed: ${errorMessage}`);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Failed to store trace' }));
      logRequest(req, res, `trace upsert error ${errorMessage}`);
    }
  };

  return { handleTraceRequest, handleTraceUpsertRequest };
};

export { createTraceHandlers };

