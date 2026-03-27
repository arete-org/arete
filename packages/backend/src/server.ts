/**
 * @description: Serves the web app and API endpoints for chat, traces, and GitHub webhooks.
 * @footnote-scope: core
 * @footnote-module: WebServer
 * @footnote-risk: high - Server failures can break user access or data integrity.
 * @footnote-ethics: high - Response generation and trace storage affect user trust and privacy.
 */
import './bootstrapEnv.js';

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createOpenAiImageRuntime,
    createOpenAiRealtimeVoiceRuntime,
    createOpenAiTtsRuntime,
    createVoltAgentRuntime,
    type GenerationRuntime,
    type ImageGenerationRuntime,
    type RealtimeVoiceRuntime,
} from '@footnote/agent-runtime';
import type { ResponseMetadata } from '@footnote/contracts/ethics-core';

import { runtimeConfig } from './config.js';
import { buildResponseMetadata } from './services/openaiService.js';
import { SimpleRateLimiter } from './services/rateLimiter.js';
import { createTraceStore, storeTrace } from './services/traceStore.js';
import { createBlogStore } from './storage/blogStore.js';
import { getDefaultIncidentStore } from './storage/incidents/incidentStore.js';
import { createAssetResolver } from './http/assets.js';
import { verifyGitHubSignature } from './utils/github.js';
import { logRequest } from './utils/requestLogger.js';
import { logger } from './utils/logger.js';
import { createVoltAgentLogger } from './utils/voltagentLogger.js';
import { createChatHandler } from './handlers/chat.js';
import { createTraceHandlers } from './handlers/trace.js';
import { createBlogHandlers } from './handlers/blog.js';
import { createIncidentHandlers } from './handlers/incidents.js';
import { createWebhookHandler } from './handlers/webhook.js';
import { createRuntimeConfigHandler } from './handlers/config.js';
import { createIncidentService } from './services/incidents.js';
import {
    createInternalImageDescriptionTaskService,
    createInternalNewsTaskService,
} from './services/internalText.js';
import { createOpenAiImageDescriptionAdapter } from './services/internalImageDescription.js';
import { createInternalImageTaskService } from './services/internalImage.js';
import { createInternalTextHandler } from './handlers/internalText.js';
import { createInternalImageHandler } from './handlers/internalImage.js';
import { createInternalVoiceTtsService } from './services/internalVoiceTts.js';
import { createInternalVoiceTtsHandler } from './handlers/internalVoiceTts.js';
import { createInternalVoiceRealtimeHandler } from './handlers/internalVoiceRealtime.js';
import { buildRealtimeInstructions } from './services/prompts/realtimePromptComposer.js';
import { createChatProfilesHandler } from './handlers/chatProfiles.js';
import { createWeatherGovForecastTool } from './services/weatherGovForecastTool.js';

/**
 * @footnote-logger: openAiRealtimeVoiceRuntime
 * @logs: Provider websocket lifecycle and session update metadata for realtime voice.
 * @footnote-risk: high - Missing logs hide provider-level realtime failures.
 * @footnote-ethics: high - Realtime audio is sensitive; log metadata only.
 */
const openAiRealtimeLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'openAiRealtimeVoiceRuntime' })
        : logger;

// --- Path configuration ---
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(currentDirectory, '../../web/dist');
const DATA_DIR = runtimeConfig.server.dataDir;
const BLOG_POSTS_DIR = path.join(DATA_DIR, 'blog-posts');
const VOLTAGENT_LOG_DIR = path.join(
    runtimeConfig.logging.directory,
    'voltagent'
);

// --- Storage and asset helpers ---
const blogStore = createBlogStore(BLOG_POSTS_DIR);
const { resolveAsset, mimeMap } = createAssetResolver(DIST_DIR);

// --- Service state ---
let traceStore: ReturnType<typeof createTraceStore> | null = null;
let incidentStore: ReturnType<typeof getDefaultIncidentStore> | null = null;
let generationRuntime: GenerationRuntime | null = null;
let imageGenerationRuntime: ImageGenerationRuntime | null = null;
const weatherForecastTool = createWeatherGovForecastTool();
let internalNewsTaskService: ReturnType<
    typeof createInternalNewsTaskService
> | null = null;
let internalImageDescriptionTaskService: ReturnType<
    typeof createInternalImageDescriptionTaskService
> | null = null;
let internalImageTaskService: ReturnType<
    typeof createInternalImageTaskService
> | null = null;
let internalVoiceTtsService: ReturnType<
    typeof createInternalVoiceTtsService
> | null = null;
let realtimeVoiceRuntime: RealtimeVoiceRuntime | null = null;
let ipRateLimiter: SimpleRateLimiter | null = null;
let sessionRateLimiter: SimpleRateLimiter | null = null;
let serviceRateLimiter: SimpleRateLimiter | null = null;
let traceWriteLimiter: SimpleRateLimiter | null = null;
const voltAgentLogger = createVoltAgentLogger({
    directory: VOLTAGENT_LOG_DIR,
    level: runtimeConfig.logging.level,
});

// --- Service initialization ---
const initializeServices = () => {
    // --- Environment visibility ---
    logger.info('Environment variables check:');
    logger.info(
        `OPENAI_API_KEY: ${runtimeConfig.openai.apiKey ? 'SET' : 'NOT SET'}`
    );
    logger.info(
        `OLLAMA_BASE_URL: ${runtimeConfig.ollama.baseUrl ? 'SET' : 'NOT SET'}`
    );
    logger.info(
        `OLLAMA_API_KEY: ${runtimeConfig.ollama.apiKey ? 'SET' : 'NOT SET'}`
    );
    logger.info(
        `OLLAMA_LOCAL_INFERENCE_ENABLED: ${runtimeConfig.ollama.localInferenceEnabled ? 'ENABLED' : 'DISABLED'}`
    );
    logger.info(
        `TURNSTILE_SECRET_KEY: ${runtimeConfig.turnstile.secretKey ? 'SET' : 'NOT SET'}`
    );
    logger.info(
        `TURNSTILE_SITE_KEY: ${runtimeConfig.turnstile.siteKey ? 'SET' : 'NOT SET'}`
    );
    logger.info(
        `VOLTOPS_TRACING_CONFIGURED: ${runtimeConfig.voltagent.observabilityEnabled ? 'ENABLED' : 'DISABLED'}`
    );
    logger.info(
        `LITESTREAM_REPLICA_URL: ${
            runtimeConfig.litestream.replicaUrl ? 'SET' : 'NOT SET'
        }`
    );
    logger.info(
        `LITESTREAM_LATEST_SNAPSHOT_AT: ${
            runtimeConfig.litestream.latestSnapshotAt || 'none yet'
        }`
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

    // Incident storage is a required Wave 1 dependency. Surface failures early.
    incidentStore = getDefaultIncidentStore();

    // --- Text generation runtime ---
    // Chat runtime can run when at least one provider is configured.
    const hasOpenAiProvider = Boolean(runtimeConfig.openai.apiKey);
    const hasOllamaCatalogProfiles = runtimeConfig.modelProfiles.catalog.some(
        (profile) => profile.provider === 'ollama'
    );
    const ollamaHostname = (() => {
        if (!runtimeConfig.ollama.baseUrl) {
            return null;
        }
        try {
            return new URL(runtimeConfig.ollama.baseUrl).hostname.toLowerCase();
        } catch {
            logger.warn(
                `OLLAMA_BASE_URL is invalid ("${runtimeConfig.ollama.baseUrl}"); ignoring ollama provider setup.`
            );
            return null;
        }
    })();
    const ollamaBaseUrlIsLocal =
        ollamaHostname === 'localhost' ||
        ollamaHostname === '127.0.0.1' ||
        ollamaHostname === '::1' ||
        ollamaHostname === 'host.docker.internal';
    if (ollamaHostname && ollamaBaseUrlIsLocal) {
        logger.info(
            runtimeConfig.ollama.localInferenceEnabled
                ? 'Ollama startup profile: local host + local inference enabled.'
                : 'Ollama startup profile: local host + local inference disabled.'
        );
    } else if (ollamaHostname) {
        logger.info(
            runtimeConfig.ollama.localInferenceEnabled
                ? 'Ollama startup profile: remote host + local inference enabled.'
                : 'Ollama startup profile: remote host + local inference disabled.'
        );
    }
    const hasOllamaProvider =
        Boolean(runtimeConfig.ollama.baseUrl) &&
        ollamaHostname !== null &&
        (!ollamaBaseUrlIsLocal || runtimeConfig.ollama.localInferenceEnabled);
    if (hasOllamaCatalogProfiles && !hasOllamaProvider) {
        logger.warn(
            'Ollama profiles are present in the model catalog, but Ollama provider is unavailable at boot. Ollama profiles will remain disabled.'
        );
    }
    if (hasOpenAiProvider || hasOllamaProvider) {
        generationRuntime = createVoltAgentRuntime({
            defaultModel: runtimeConfig.openai.defaultModel,
            logger: voltAgentLogger,
            ollama: {
                baseUrl: runtimeConfig.ollama.baseUrl ?? undefined,
                apiKey: runtimeConfig.ollama.apiKey ?? undefined,
                localInferenceEnabled:
                    runtimeConfig.ollama.localInferenceEnabled,
            },
            ...(runtimeConfig.voltagent.observabilityEnabled && {
                voltOps: {
                    publicKey: runtimeConfig.voltagent.publicKey!,
                    secretKey: runtimeConfig.voltagent.secretKey!,
                },
            }),
        });
    } else {
        generationRuntime = null;
        logger.warn(
            'No text-generation provider is configured. Set OPENAI_API_KEY or OLLAMA_BASE_URL to enable /api/chat.'
        );
    }

    // --- OpenAI-only services ---
    if (runtimeConfig.openai.apiKey) {
        imageGenerationRuntime = createOpenAiImageRuntime({
            apiKey: runtimeConfig.openai.apiKey,
            requestTimeoutMs: runtimeConfig.openai.requestTimeoutMs,
        });
        internalNewsTaskService =
            generationRuntime !== null
                ? createInternalNewsTaskService({
                      generationRuntime,
                      defaultModel: runtimeConfig.openai.defaultModel,
                  })
                : null;
        internalImageDescriptionTaskService =
            createInternalImageDescriptionTaskService({
                adapter: createOpenAiImageDescriptionAdapter({
                    apiKey: runtimeConfig.openai.apiKey,
                    requestTimeoutMs: runtimeConfig.openai.requestTimeoutMs,
                }),
            });
        internalImageTaskService = createInternalImageTaskService({
            imageGenerationRuntime,
        });
        internalVoiceTtsService = createInternalVoiceTtsService({
            ttsRuntime: createOpenAiTtsRuntime({
                apiKey: runtimeConfig.openai.apiKey,
                requestTimeoutMs: runtimeConfig.openai.requestTimeoutMs,
            }),
        });
        realtimeVoiceRuntime = createOpenAiRealtimeVoiceRuntime({
            apiKey: runtimeConfig.openai.apiKey,
            requestTimeoutMs: runtimeConfig.openai.requestTimeoutMs,
            defaultModel: runtimeConfig.openai.defaultRealtimeModel,
            defaultVoice: runtimeConfig.openai.defaultRealtimeVoice,
            logger: openAiRealtimeLogger,
        });
    } else {
        imageGenerationRuntime = null;
        internalNewsTaskService = null;
        internalImageDescriptionTaskService = null;
        internalImageTaskService = null;
        internalVoiceTtsService = null;
        realtimeVoiceRuntime = null;
        logger.warn(
            'OPENAI_API_KEY is missing; OpenAI-only image and voice routes will return 503 until configured.'
        );
    }

    // --- Rate limiter configuration ---
    // Per-IP request limiter for /api/chat.
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
        limit: runtimeConfig.rateLimits.chatService.limit,
        window: runtimeConfig.rateLimits.chatService.windowMs,
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
    process.exit(1);
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
const {
    handleTraceRequest,
    handleTraceUpsertRequest,
    handleTraceCardCreateRequest,
    handleTraceCardFromTraceRequest,
    handleTraceCardAssetRequest,
} = createTraceHandlers({
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
if (!incidentStore) {
    throw new Error('Incident store did not initialize correctly.');
}
const incidentService = createIncidentService({ incidentStore });
const {
    handleIncidentReportRequest,
    handleIncidentListRequest,
    handleIncidentDetailRequest,
    handleIncidentStatusRequest,
    handleIncidentNotesRequest,
    handleIncidentRemediationRequest,
} = createIncidentHandlers({
    incidentService,
    logRequest,
    maxIncidentBodyBytes: runtimeConfig.reflect.maxBodyBytes,
    traceApiToken: runtimeConfig.trace.apiToken,
    serviceToken: runtimeConfig.reflect.serviceToken,
});
const handleRuntimeConfigRequest = createRuntimeConfigHandler({ logRequest });
const handleChatProfilesRequest = createChatProfilesHandler({ logRequest });
const handleWebhookRequest = createWebhookHandler({
    writeBlogPost: blogStore.writeBlogPost,
    verifyGitHubSignature,
    logRequest,
});
const { handleInternalTextRequest } = createInternalTextHandler({
    internalNewsTaskService,
    internalImageDescriptionTaskService,
    logRequest,
    maxBodyBytes: runtimeConfig.reflect.maxBodyBytes,
    traceApiToken: runtimeConfig.trace.apiToken,
    serviceToken: runtimeConfig.reflect.serviceToken,
    serviceRateLimiter:
        serviceRateLimiter ??
        new SimpleRateLimiter({
            limit: runtimeConfig.rateLimits.chatService.limit,
            window: runtimeConfig.rateLimits.chatService.windowMs,
        }),
});
const { handleInternalImageRequest } = createInternalImageHandler({
    internalImageTaskService,
    logRequest,
    maxBodyBytes: runtimeConfig.reflect.maxBodyBytes,
    traceApiToken: runtimeConfig.trace.apiToken,
    serviceToken: runtimeConfig.reflect.serviceToken,
    serviceRateLimiter:
        serviceRateLimiter ??
        new SimpleRateLimiter({
            limit: runtimeConfig.rateLimits.chatService.limit,
            window: runtimeConfig.rateLimits.chatService.windowMs,
        }),
});
const { handleInternalVoiceTtsRequest } = createInternalVoiceTtsHandler({
    internalVoiceTtsService,
    logRequest,
    maxBodyBytes: runtimeConfig.reflect.maxBodyBytes,
    traceApiToken: runtimeConfig.trace.apiToken,
    serviceToken: runtimeConfig.reflect.serviceToken,
    serviceRateLimiter:
        serviceRateLimiter ??
        new SimpleRateLimiter({
            limit: runtimeConfig.rateLimits.chatService.limit,
            window: runtimeConfig.rateLimits.chatService.windowMs,
        }),
});
const { handleUpgrade: handleInternalVoiceRealtimeUpgrade } =
    createInternalVoiceRealtimeHandler({
        realtimeVoiceRuntime,
        traceApiToken: runtimeConfig.trace.apiToken,
        serviceToken: runtimeConfig.reflect.serviceToken,
        serviceRateLimiter:
            serviceRateLimiter ??
            new SimpleRateLimiter({
                limit: runtimeConfig.rateLimits.chatService.limit,
                window: runtimeConfig.rateLimits.chatService.windowMs,
            }),
        buildInstructions: buildRealtimeInstructions,
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
// Chat is the backend-standardized conversation interface (adapter-facing, Turnstile + rate-limited for public web calls).
const handleChatRequest = createChatHandler({
    generationRuntime,
    weatherForecastTool,
    ipRateLimiter,
    sessionRateLimiter,
    serviceRateLimiter,
    storeTrace: storeTraceWithStore,
    logRequest,
    buildResponseMetadata,
    maxChatBodyBytes: runtimeConfig.reflect.maxBodyBytes,
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
        const normalizedPathname =
            parsedUrl.pathname.length > 1 && parsedUrl.pathname.endsWith('/')
                ? parsedUrl.pathname.slice(0, -1)
                : parsedUrl.pathname;

        // --- API routes ---
        if (normalizedPathname === '/api/webhook/github') {
            await handleWebhookRequest(req, res);
            return;
        }

        if (normalizedPathname === '/config.json') {
            await handleRuntimeConfigRequest(req, res);
            return;
        }

        if (normalizedPathname === '/api/incidents') {
            await handleIncidentListRequest(req, res, parsedUrl);
            return;
        }

        if (normalizedPathname === '/api/incidents/report') {
            await handleIncidentReportRequest(req, res);
            return;
        }

        if (normalizedPathname === '/api/internal/text') {
            await handleInternalTextRequest(req, res);
            return;
        }

        if (normalizedPathname === '/api/internal/image') {
            await handleInternalImageRequest(req, res);
            return;
        }

        if (normalizedPathname === '/api/internal/voice/tts') {
            await handleInternalVoiceTtsRequest(req, res);
            return;
        }

        if (/^\/api\/incidents\/[^/]+\/status$/.test(normalizedPathname)) {
            await handleIncidentStatusRequest(req, res, parsedUrl);
            return;
        }

        if (/^\/api\/incidents\/[^/]+\/notes$/.test(normalizedPathname)) {
            await handleIncidentNotesRequest(req, res, parsedUrl);
            return;
        }

        if (/^\/api\/incidents\/[^/]+\/remediation$/.test(normalizedPathname)) {
            await handleIncidentRemediationRequest(req, res, parsedUrl);
            return;
        }

        if (/^\/api\/incidents\/[^/]+$/.test(normalizedPathname)) {
            await handleIncidentDetailRequest(req, res, parsedUrl);
            return;
        }

        if (normalizedPathname === '/api/blog-posts') {
            await handleBlogIndexRequest(req, res);
            return;
        }

        if (normalizedPathname.startsWith('/api/blog-posts/')) {
            const postId = normalizedPathname.split('/').pop() || '';
            await handleBlogPostRequest(req, res, postId);
            return;
        }

        if (normalizedPathname === '/api/traces') {
            await handleTraceUpsertRequest(req, res);
            return;
        }

        if (normalizedPathname === '/api/trace-cards') {
            await handleTraceCardCreateRequest(req, res);
            return;
        }

        if (normalizedPathname === '/api/trace-cards/from-trace') {
            await handleTraceCardFromTraceRequest(req, res);
            return;
        }

        if (
            /^\/api\/traces\/[^/]+\/assets\/trace-card\.svg$/.test(
                normalizedPathname
            )
        ) {
            await handleTraceCardAssetRequest(req, res, parsedUrl);
            return;
        }

        // --- Trace retrieval route (JSON only) ---
        // This path also doubles as a browser route for the trace page.
        // We only return JSON when the caller explicitly asks for JSON.
        if (normalizedPathname.startsWith('/api/traces/')) {
            // This endpoint can return HTML or JSON depending on the Accept header.
            // Tell caches to keep those two versions separate (so a JSON request never gets a cached HTML page and vice versa).
            res.setHeader('Vary', 'Accept');
            if (wantsJsonResponse(req)) {
                logger.debug(`Trace route matched: ${normalizedPathname}`);
                await handleTraceRequest(req, res, parsedUrl);
                return;
            }
            // Fall through to the static asset resolver for the SPA.
        }

        if (normalizedPathname === '/api/chat') {
            await handleChatRequest(req, res);
            return;
        }

        if (normalizedPathname === '/api/chat/profiles') {
            await handleChatProfilesRequest(req, res);
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

server.on('upgrade', (req, socket, head) => {
    if (!req.url) {
        socket.destroy();
        return;
    }

    try {
        const parsedUrl = new URL(req.url, 'http://localhost');
        const normalizedPathname =
            parsedUrl.pathname.length > 1 && parsedUrl.pathname.endsWith('/')
                ? parsedUrl.pathname.slice(0, -1)
                : parsedUrl.pathname;

        if (normalizedPathname === '/api/internal/voice/realtime') {
            handleInternalVoiceRealtimeUpgrade(req, socket, head);
            return;
        }
    } catch (error) {
        logger.error(
            `Failed to process websocket upgrade: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }

    socket.destroy();
});

let isShuttingDown = false;
const shutdownGracefully = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;
    logger.info(`Received ${signal}; starting graceful shutdown.`);

    // Order matters:
    // 1) checkpoint WAL so replicated snapshots include recent writes
    // 2) close stores so file locks are released before process exit
    // 3) close HTTP server and then terminate with explicit exit status
    try {
        traceStore?.checkpointWalTruncate();
    } catch (error) {
        logger.error(
            `Failed trace-store WAL checkpoint during shutdown: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }

    try {
        incidentStore?.checkpointWalTruncate();
    } catch (error) {
        logger.error(
            `Failed incident-store WAL checkpoint during shutdown: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }

    try {
        traceStore?.close();
    } catch (error) {
        logger.error(
            `Failed to close trace store during shutdown: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    } finally {
        traceStore = null;
    }

    try {
        incidentStore?.close();
    } catch (error) {
        logger.error(
            `Failed to close incident store during shutdown: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    } finally {
        incidentStore = null;
    }

    const forceExitTimer = setTimeout(() => {
        logger.error(
            'Graceful shutdown timeout reached; forcing process termination.'
        );
        process.exit(1);
    }, 10000);
    forceExitTimer.unref();

    server.close((error) => {
        if (error) {
            logger.error(
                `Server close failed during shutdown: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
            process.exit(1);
            return;
        }

        logger.info('Graceful shutdown complete.');
        process.exit(0);
    });
};

process.once('SIGINT', () => shutdownGracefully('SIGINT'));
process.once('SIGTERM', () => shutdownGracefully('SIGTERM'));

// --- Server startup ---
const port = runtimeConfig.server.port;
const host = runtimeConfig.server.host;
server.listen(port, host, () => {
    logger.info(`Simple server available on ${host}:${port}`);
});
