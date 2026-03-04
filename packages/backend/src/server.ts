/**
 * @description: Serves the web app and API endpoints for reflect, traces, and GitHub webhooks.
 * @footnote-scope: core
 * @footnote-module: WebServer
 * @footnote-risk: high - Server failures can break user access or data integrity.
 * @footnote-ethics: high - Response generation and trace storage affect user trust and privacy.
 */
import './bootstrapEnv.js';

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResponseMetadata } from '@footnote/contracts/ethics-core';

import { runtimeConfig } from './config.js';
import {
    type OpenAIService,
    SimpleOpenAIService,
    buildResponseMetadata,
} from './services/openaiService.js';
import { SimpleRateLimiter } from './services/rateLimiter.js';
import { createTraceStore, storeTrace } from './services/traceStore.js';
import { createBlogStore } from './storage/blogStore.js';
import { createAssetResolver } from './http/assets.js';
import { verifyGitHubSignature } from './utils/github.js';
import { logRequest } from './utils/requestLogger.js';
import { logger } from './utils/logger.js';
import { createReflectHandler } from './handlers/reflect.js';
import { createTraceHandlers } from './handlers/trace.js';
import { createBlogHandlers } from './handlers/blog.js';
import { createWebhookHandler } from './handlers/webhook.js';
import { createRuntimeConfigHandler } from './handlers/config.js';

// --- Path configuration ---
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(currentDirectory, '../../web/dist');
const DATA_DIR = runtimeConfig.server.dataDir;
const BLOG_POSTS_DIR = path.join(DATA_DIR, 'blog-posts');

// --- Storage and asset helpers ---
const blogStore = createBlogStore(BLOG_POSTS_DIR);
const { resolveAsset, mimeMap } = createAssetResolver(DIST_DIR);

// --- Service state ---
let traceStore: ReturnType<typeof createTraceStore> | null = null;
let openaiService: OpenAIService | null = null;
let ipRateLimiter: SimpleRateLimiter | null = null;
let sessionRateLimiter: SimpleRateLimiter | null = null;
let serviceRateLimiter: SimpleRateLimiter | null = null;
let traceWriteLimiter: SimpleRateLimiter | null = null;

// --- Service initialization ---
const initializeServices = () => {
    // --- Environment visibility ---
    logger.info('Environment variables check:');
    logger.info(
        `OPENAI_API_KEY: ${runtimeConfig.openai.apiKey ? 'SET' : 'NOT SET'}`
    );
    logger.info(
        `TURNSTILE_SECRET_KEY: ${runtimeConfig.turnstile.secretKey ? 'SET' : 'NOT SET'}`
    );
    logger.info(
        `TURNSTILE_SITE_KEY: ${runtimeConfig.turnstile.siteKey ? 'SET' : 'NOT SET'}`
    );
    logger.info(`NODE_ENV: ${runtimeConfig.runtime.nodeEnv}`);

    // --- Trace store ---
    try {
        // Initialize trace storage even when OpenAI is disabled.
        traceStore = createTraceStore();
    } catch (error) {
        traceStore = null;
        logger.error(
            `Failed to initialize trace store: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    // --- OpenAI service ---
    if (runtimeConfig.openai.apiKey) {
        // Only enable OpenAI when an API key is configured.
        openaiService = new SimpleOpenAIService(runtimeConfig.openai.apiKey);
    } else {
        openaiService = null;
        logger.warn(
            'OPENAI_API_KEY is missing; /api/reflect will return 503 until configured.'
        );
    }

    // --- Rate limiter configuration ---
    // Per-IP request limiter for /api/reflect.
    ipRateLimiter = new SimpleRateLimiter({
        limit: runtimeConfig.rateLimits.web.ip.limit,
        window: runtimeConfig.rateLimits.web.ip.windowMs,
    });

    // Per-session limiter to reduce abuse when multiple users share IPs.
    sessionRateLimiter = new SimpleRateLimiter({
        limit: runtimeConfig.rateLimits.web.session.limit,
        window: runtimeConfig.rateLimits.web.session.windowMs,
    });

    // Trusted service calls get their own limiter so internal callers do not consume browser quota.
    serviceRateLimiter = new SimpleRateLimiter({
        limit: runtimeConfig.rateLimits.reflectService.limit,
        window: runtimeConfig.rateLimits.reflectService.windowMs,
    });

    // Separate limiter for trace ingestion to avoid coupling to reflect limits.
    traceWriteLimiter = new SimpleRateLimiter({
        limit: runtimeConfig.rateLimits.traceApi.limit,
        window: runtimeConfig.rateLimits.traceApi.windowMs,
    });

    // --- Cleanup loop ---
    // Background cleanup keeps in-memory rate limiter maps from growing forever.
    setInterval(
        () => {
            ipRateLimiter?.cleanup();
            sessionRateLimiter?.cleanup();
            serviceRateLimiter?.cleanup();
            traceWriteLimiter?.cleanup();
        },
        2 * 60 * 1000
    );

    logger.info('Services initialized successfully');
};

try {
    initializeServices();
} catch (error) {
    logger.error(
        `Failed to initialize services: ${error instanceof Error ? error.message : String(error)}`
    );
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
const { handleTraceRequest, handleTraceUpsertRequest } = createTraceHandlers({
    traceStore,
    logRequest,
    traceWriteLimiter,
    traceToken: runtimeConfig.trace.apiToken,
    maxTraceBodyBytes: runtimeConfig.trace.maxBodyBytes,
    trustProxy: runtimeConfig.server.trustProxy,
});
const { handleBlogIndexRequest, handleBlogPostRequest } = createBlogHandlers({
    blogStore,
    logRequest,
});
const handleRuntimeConfigRequest = createRuntimeConfigHandler({ logRequest });
const handleWebhookRequest = createWebhookHandler({
    writeBlogPost: blogStore.writeBlogPost,
    verifyGitHubSignature,
    logRequest,
});
// Decide whether /api/traces/:responseId should return JSON or the SPA HTML shell.
// We default to JSON unless the Accept header clearly asks for HTML.
// This keeps API clients working even when they send a generic "*/*" Accept header.
const wantsJsonResponse = (req: http.IncomingMessage): boolean => {
    const headerValue = req.headers.accept;
    const acceptHeader = Array.isArray(headerValue)
        ? headerValue.join(',')
        : headerValue || '';
    const normalized = acceptHeader.toLowerCase();
    const wantsHtml =
        normalized.includes('text/html') ||
        normalized.includes('application/xhtml+xml');
    const wantsJson =
        normalized.includes('application/json') || normalized.includes('+json');

    if (wantsHtml && !wantsJson) {
        return false;
    }

    return true;
};
// Reflection is the slim, web-facing chat interface (Turnstile + rate-limited).
const handleReflectRequest = createReflectHandler({
    openaiService,
    ipRateLimiter,
    sessionRateLimiter,
    serviceRateLimiter,
    storeTrace: storeTraceWithStore,
    logRequest,
    buildResponseMetadata,
    maxReflectBodyBytes: runtimeConfig.reflect.maxBodyBytes,
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

        if (
            parsedUrl.pathname === '/api/blog-posts' ||
            parsedUrl.pathname === '/api/blog-posts/'
        ) {
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

        // --- Trace retrieval route (JSON only) ---
        // This path also doubles as a browser route for the trace page.
        // We only return JSON when the caller explicitly asks for JSON.
        if (parsedUrl.pathname.startsWith('/api/traces/')) {
            // This endpoint can return HTML or JSON depending on the Accept header.
            // Tell caches to keep those two versions separate (so a JSON request never gets a cached HTML page and vice versa).
            res.setHeader('Vary', 'Accept');
            if (wantsJsonResponse(req)) {
                logger.debug(`Trace route matched: ${parsedUrl.pathname}`);
                await handleTraceRequest(req, res, parsedUrl);
                return;
            }
            // Fall through to the static asset resolver for the SPA.
        }

        if (parsedUrl.pathname === '/api/reflect') {
            await handleReflectRequest(req, res);
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
        const contentType =
            mimeMap.get(extension) || 'application/octet-stream';

        // --- Static response headers ---
        res.statusCode = 200;
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=600');

        // --- Content Security Policy ---
        // Apply CSP only for HTML responses and embed routes.
        const isHtml =
            contentType.includes('text/html') ||
            parsedUrl.pathname === '/' ||
            parsedUrl.pathname.endsWith('.html') ||
            parsedUrl.pathname.startsWith('/embed');

        if (isHtml) {
            const forwardedProto =
                typeof req.headers['x-forwarded-proto'] === 'string'
                    ? req.headers['x-forwarded-proto']
                    : undefined;
            const scheme = forwardedProto?.split(',')[0].trim() || 'http';
            const hostHeader =
                typeof req.headers.host === 'string'
                    ? req.headers.host.trim()
                    : '';
            const requestOrigin = hostHeader ? `${scheme}://${hostHeader}` : '';

            // Always allow self + current host, then merge configured frame ancestors.
            const mergedFrameAncestors = [
                "'self'",
                ...(requestOrigin ? [requestOrigin] : []),
                ...runtimeConfig.csp.frameAncestors,
            ];
            const trimTrailingSlashes = (value: string): string => {
                let end = value.length;
                while (end > 0 && value[end - 1] === '/') {
                    end -= 1;
                }
                return value.slice(0, end);
            };

            const normalizedFrameAncestors = [
                ...new Set(
                    mergedFrameAncestors.map((domain) =>
                        trimTrailingSlashes(domain)
                    )
                ),
            ];

            const csp = [
                `frame-ancestors ${normalizedFrameAncestors.join(' ')}`,
                "default-src 'self'",
                "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https://challenges.cloudflare.com",
                "style-src 'self' 'unsafe-inline' data:",
                "img-src 'self' data: blob:",
                "font-src 'self' data:",
                "frame-src 'self' https://challenges.cloudflare.com",
                "connect-src 'self' https://challenges.cloudflare.com https://api.openai.com",
            ].join('; ');
            res.setHeader('Content-Security-Policy', csp);
        }

        res.end(asset.content);
        logRequest(req, res);
    } catch (error) {
        res.statusCode = 500;
        res.end('Internal Server Error');
        logRequest(
            req,
            res,
            error instanceof Error ? error.message : 'unknown error'
        );
    }
});

// --- Server startup ---
const port = runtimeConfig.server.port;
const host = runtimeConfig.server.host;
server.listen(port, host, () => {
    logger.info(`Simple server available on ${host}:${port}`);
});
