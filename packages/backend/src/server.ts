/**
 * @description: Serves the web app and API endpoints for reflect, traces, and GitHub webhooks.
 * @arete-scope: core
 * @arete-module: WebServer
 * @arete-risk: high - Server failures can break user access or data integrity.
 * @arete-ethics: high - Response generation and trace storage affect user trust and privacy.
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

import { runtimeConfig } from './config';
import { SimpleOpenAIService, buildResponseMetadata } from './services/openaiService';
import { SimpleRateLimiter } from './services/rateLimiter';
import type { ResponseMetadata } from './ethics-core';
import { createTraceStore, storeTrace } from './services/traceStore';
import { createBlogStore } from './storage/blogStore';
import { createAssetResolver } from './http/assets';
import { verifyGitHubSignature } from './utils/github';
import { logRequest } from './utils/requestLogger';
import { logger } from './shared/logger';
import { createReflectHandler } from './handlers/reflect';
import { createTraceHandlers } from './handlers/trace';
import { createBlogHandlers } from './handlers/blog';
import { createWebhookHandler } from './handlers/webhook';
import { createRuntimeConfigHandler } from './handlers/config';

// --- Environment bootstrap ---
// Load environment variables from .env file when present (skip inside containers).
if (fs.existsSync(path.join(__dirname, '../../../.env'))) {
  require('dotenv').config();
}

// --- Path configuration ---
const DIST_DIR = path.join(__dirname, '../../web/dist');
const DATA_DIR = process.env.ARETE_DATA_DIR || '/data';
const BLOG_POSTS_DIR = path.join(DATA_DIR, 'blog-posts');

// --- Storage and asset helpers ---
const blogStore = createBlogStore(BLOG_POSTS_DIR);
const { resolveAsset, mimeMap } = createAssetResolver(DIST_DIR);

// --- Service state ---
let traceStore: ReturnType<typeof createTraceStore> | null = null;
let openaiService: SimpleOpenAIService | null = null;
let ipRateLimiter: SimpleRateLimiter | null = null;
let sessionRateLimiter: SimpleRateLimiter | null = null;
let traceWriteLimiter: SimpleRateLimiter | null = null;

// --- Service initialization ---
const initializeServices = () => {
  // --- Environment visibility ---
  logger.info('Environment variables check:');
  logger.info(`OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? 'SET' : 'NOT SET'}`);
  logger.info(`TURNSTILE_SECRET_KEY: ${process.env.TURNSTILE_SECRET_KEY ? 'SET' : 'NOT SET'}`);
  logger.info(`TURNSTILE_SITE_KEY: ${process.env.TURNSTILE_SITE_KEY ? 'SET' : 'NOT SET'}`);
  logger.info(`NODE_ENV: ${process.env.NODE_ENV || 'NOT SET'}`);

  // --- Trace store ---
  try {
    // Initialize trace storage even when OpenAI is disabled.
    traceStore = createTraceStore();
  } catch (error) {
    traceStore = null;
    logger.error(`Failed to initialize trace store: ${error instanceof Error ? error.message : String(error)}`);
  }

  // --- OpenAI service ---
  if (process.env.OPENAI_API_KEY) {
    // Only enable OpenAI when an API key is configured.
    openaiService = new SimpleOpenAIService(process.env.OPENAI_API_KEY);
  } else {
    openaiService = null;
    logger.warn('OPENAI_API_KEY is missing; /api/reflect will return 503 until configured.');
  }

  // --- Rate limiter configuration ---
  // Per-IP request limiter for /api/reflect.
  ipRateLimiter = new SimpleRateLimiter({
    limit: parseInt(process.env.WEB_API_RATE_LIMIT_IP || '3', 10),
    window: parseInt(process.env.WEB_API_RATE_LIMIT_IP_WINDOW_MS || '60000', 10)
  });

  // Per-session limiter to reduce abuse when multiple users share IPs.
  sessionRateLimiter = new SimpleRateLimiter({
    limit: parseInt(process.env.WEB_API_RATE_LIMIT_SESSION || '5', 10),
    window: parseInt(process.env.WEB_API_RATE_LIMIT_SESSION_WINDOW_MS || '60000', 10)
  });

  // Separate limiter for trace ingestion to avoid coupling to reflect limits.
  traceWriteLimiter = new SimpleRateLimiter({
    limit: parseInt(process.env.TRACE_API_RATE_LIMIT || '10', 10),
    window: parseInt(process.env.TRACE_API_RATE_LIMIT_WINDOW_MS || '60000', 10)
  });

  // --- Cleanup loop ---
  // Background cleanup keeps in-memory rate limiter maps from growing forever.
  setInterval(() => {
    ipRateLimiter?.cleanup();
    sessionRateLimiter?.cleanup();
    traceWriteLimiter?.cleanup();
  }, 2 * 60 * 1000);

  logger.info('Services initialized successfully');
};

try {
  initializeServices();
} catch (error) {
  logger.error(`Failed to initialize services: ${error instanceof Error ? error.message : String(error)}`);
}

// --- Trace storage wrapper ---
const storeTraceWithStore = (metadata: ResponseMetadata) => {
  // Prevent trace writes when the store failed to initialize.
  if (!traceStore) {
    return Promise.reject(new Error('Trace store is not initialized'));
  }
  return storeTrace(traceStore, metadata);
};

// --- Handler wiring ---
const trustProxy = process.env.WEB_TRUST_PROXY === 'true';
// Guard the max body bytes to a sane numeric value.
const maxTraceBodyBytesEnv = parseInt(process.env.TRACE_API_MAX_BODY_BYTES || '200000', 10);
const maxTraceBodyBytes = Number.isFinite(maxTraceBodyBytesEnv) && maxTraceBodyBytesEnv > 0
  ? maxTraceBodyBytesEnv
  : 200000;
const maxReflectBodyBytesEnv = parseInt(process.env.REFLECT_API_MAX_BODY_BYTES || '20000', 10);
const maxReflectBodyBytes = Number.isFinite(maxReflectBodyBytesEnv) && maxReflectBodyBytesEnv > 0
  ? maxReflectBodyBytesEnv
  : 20000;
const traceToken = process.env.TRACE_API_TOKEN?.trim() || null;

const { handleTraceRequest, handleTraceUpsertRequest } = createTraceHandlers({
  traceStore,
  logRequest,
  traceWriteLimiter,
  traceToken,
  maxTraceBodyBytes,
  trustProxy
});
const { handleBlogIndexRequest, handleBlogPostRequest } = createBlogHandlers({
  blogStore,
  logRequest
});
const handleRuntimeConfigRequest = createRuntimeConfigHandler({ logRequest });
const handleWebhookRequest = createWebhookHandler({
  writeBlogPost: blogStore.writeBlogPost,
  verifyGitHubSignature,
  logRequest
});
const handleReflectRequest = createReflectHandler({
  openaiService,
  ipRateLimiter,
  sessionRateLimiter,
  storeTrace: storeTraceWithStore,
  logRequest,
  buildResponseMetadata,
  maxReflectBodyBytes
});

// --- HTTP server ---
const server = http.createServer(async (req, res) => {
  // --- Early request guard ---
  if (!req.url) {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }

  try {
    // --- URL parsing ---
    const parsedUrl = new URL(req.url, 'http://localhost');

    // --- API routes ---
    if (parsedUrl.pathname === '/api/webhook/github') {
      await handleWebhookRequest(req, res);
      return;
    }

    if (parsedUrl.pathname === '/config.json') {
      await handleRuntimeConfigRequest(req, res);
      return;
    }

    if (parsedUrl.pathname === '/api/blog-posts' || parsedUrl.pathname === '/api/blog-posts/') {
      await handleBlogIndexRequest(req, res);
      return;
    }

    if (parsedUrl.pathname.startsWith('/api/blog-posts/')) {
      const postId = parsedUrl.pathname.split('/').pop() || '';
      await handleBlogPostRequest(req, res, postId);
      return;
    }

    if (parsedUrl.pathname === '/api/traces') {
      await handleTraceUpsertRequest(req, res);
      return;
    }

    if (parsedUrl.pathname === '/api/reflect') {
      await handleReflectRequest(req, res, parsedUrl);
      return;
    }

    // --- Trace retrieval route ---
    if (parsedUrl.pathname.startsWith('/trace/') && parsedUrl.pathname.endsWith('.json')) {
      logger.debug(`Trace route matched: ${parsedUrl.pathname}`);
      await handleTraceRequest(req, res, parsedUrl);
      return;
    }

    // --- Static assets ---
    const asset = await resolveAsset(req.url);

    if (!asset) {
      res.statusCode = 404;
      res.end('Not Found');
      logRequest(req, res, '(missing asset, index.html unavailable)');
      return;
    }

    const extension = path.extname(asset.absolutePath).toLowerCase();
    const contentType = mimeMap.get(extension) || 'application/octet-stream';

    // --- Static response headers ---
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=600');

    // --- Content Security Policy ---
    // Apply CSP only for HTML responses and embed routes.
    const isHtml = contentType.includes('text/html') || parsedUrl.pathname === '/' ||
                   parsedUrl.pathname.endsWith('.html') || parsedUrl.pathname.startsWith('/embed');

    if (isHtml) {
      const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string'
        ? req.headers['x-forwarded-proto']
        : undefined;
      const scheme = forwardedProto?.split(',')[0].trim() || 'http';
      const hostHeader = typeof req.headers.host === 'string' ? req.headers.host.trim() : '';
      const requestOrigin = hostHeader ? `${scheme}://${hostHeader}` : '';

      // Always allow self + current host, then merge configured frame ancestors.
      const mergedFrameAncestors = [
        "'self'",
        ...(requestOrigin ? [requestOrigin] : []),
        ...runtimeConfig.csp.frameAncestors
      ];
      const trimTrailingSlashes = (value: string): string => {
        let end = value.length;
        while (end > 0 && value[end - 1] === '/') {
          end -= 1;
        }
        return value.slice(0, end);
      };

      const normalizedFrameAncestors = [...new Set(
        mergedFrameAncestors.map(domain => trimTrailingSlashes(domain))
      )];

      const csp = [
        `frame-ancestors ${normalizedFrameAncestors.join(' ')}`,
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https://challenges.cloudflare.com",
        "style-src 'self' 'unsafe-inline' data:",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "frame-src 'self' https://challenges.cloudflare.com",
        "connect-src 'self' https://challenges.cloudflare.com https://api.openai.com"
      ].join('; ');
      res.setHeader('Content-Security-Policy', csp);
    }

    res.end(asset.content);
    logRequest(req, res);
  } catch (error) {
    res.statusCode = 500;
    res.end('Internal Server Error');
    logRequest(req, res, error instanceof Error ? error.message : 'unknown error');
  }
});

// --- Server startup ---
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '::';
server.listen(port, host, () => {
  logger.info(`Simple server available on ${host}:${port}`);
});

