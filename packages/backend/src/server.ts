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
import { createExpressApp } from './http/expressApp.js';
import {
    createRouteDispatcher,
    normalizePathname,
} from './http/routeDispatch.js';
import { handleStaticTransportRequest } from './http/staticTransport.js';
import { handleUpgradeBoundary } from './http/upgradeBoundary.js';
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
import { createIncidentAlertRouter } from './services/incidentAlerts.js';
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
import { resolveExecutionContractTrustGraphRuntimeOptions } from './services/executionContractTrustGraph/index.js';
import { createModelProfileResolver } from './services/modelProfileResolver.js';

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
let incidentStoreUnavailableReason: string | null = null;
let generationRuntime: GenerationRuntime | null = null;
let imageGenerationRuntime: ImageGenerationRuntime | null = null;
let weatherForecastTool: ReturnType<
    typeof createWeatherGovForecastTool
> | null = null;
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
let blogReadRateLimiter: SimpleRateLimiter | null = null;
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

    // Incident storage is optional at runtime. When unavailable, keep backend
    // online and return explicit 503 responses for incident routes.
    try {
        incidentStore = getDefaultIncidentStore();
        incidentStoreUnavailableReason = null;
    } catch (error) {
        incidentStore = null;
        incidentStoreUnavailableReason =
            error instanceof Error ? error.message : String(error);
        logger.error(
            `Incident store unavailable; incident routes will return 503. ${incidentStoreUnavailableReason}`
        );
    }

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
    logger.info(
        `Text generation provider availability: openai=${hasOpenAiProvider ? 'available' : 'unavailable'}, ollama=${hasOllamaProvider ? 'available' : 'unavailable'}`
    );
    if (hasOllamaCatalogProfiles && !hasOllamaProvider) {
        logger.warn(
            'Ollama profiles are present in the model catalog, but Ollama provider is unavailable at boot. Ollama profiles will remain disabled.'
        );
    }
    const startupModelProfileResolver = createModelProfileResolver({
        catalog: runtimeConfig.modelProfiles.catalog,
        defaultProfileId: runtimeConfig.modelProfiles.defaultProfileId,
        legacyDefaultModel: runtimeConfig.openai.defaultModel,
        warn: logger,
    });
    const startupDefaultProfile = startupModelProfileResolver.defaultProfile;
    const generationRuntimeDefaultModel = `${startupDefaultProfile.provider}/${startupDefaultProfile.providerModel}`;
    logger.info(
        `Core generation runtime default profile: ${startupDefaultProfile.id} (${generationRuntimeDefaultModel}).`
    );
    if (hasOpenAiProvider || hasOllamaProvider) {
        generationRuntime = createVoltAgentRuntime({
            defaultModel: generationRuntimeDefaultModel,
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

    internalNewsTaskService =
        generationRuntime !== null
            ? createInternalNewsTaskService({
                  generationRuntime,
                  defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
              })
            : null;
    if (!internalNewsTaskService) {
        logger.warn(
            'Internal news task is unavailable because no text-generation provider is configured.'
        );
    }

    // Keep weather adapter construction in service bootstrap so runtime config
    // can control pilot enablement/behavior without import-time wiring.
    weatherForecastTool = createWeatherGovForecastTool();

    // --- OpenAI-only services ---
    if (runtimeConfig.openai.apiKey) {
        imageGenerationRuntime = createOpenAiImageRuntime({
            apiKey: runtimeConfig.openai.apiKey,
            requestTimeoutMs: runtimeConfig.openai.requestTimeoutMs,
        });
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
    // Public blog reads perform file-system access; keep a lightweight limiter for DoS resistance.
    blogReadRateLimiter = new SimpleRateLimiter({
        limit: runtimeConfig.rateLimits.web.ip.limit,
        window: runtimeConfig.rateLimits.web.ip.windowMs,
    });

    // --- Cleanup loop ---
    // Background cleanup keeps in-memory rate limiter maps from growing forever.
    setInterval(
        () => {
            ipRateLimiter?.cleanup();
            sessionRateLimiter?.cleanup();
            serviceRateLimiter?.cleanup();
            traceWriteLimiter?.cleanup();
            blogReadRateLimiter?.cleanup();
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
const incidentAlertRouter = createIncidentAlertRouter({
    config: runtimeConfig.alerts,
});
const writeIncidentUnavailable = (res: http.ServerResponse): void => {
    if (res.headersSent) {
        return;
    }

    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
        JSON.stringify({
            error: 'Incident subsystem unavailable',
            code: 'INCIDENT_SERVICE_UNAVAILABLE',
        })
    );
};

let handleIncidentReportRequest: (
    req: http.IncomingMessage,
    res: http.ServerResponse
) => Promise<void>;
let handleIncidentListRequest: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedUrl: URL
) => Promise<void>;
let handleIncidentDetailRequest: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedUrl: URL
) => Promise<void>;
let handleIncidentStatusRequest: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedUrl: URL
) => Promise<void>;
let handleIncidentNotesRequest: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedUrl: URL
) => Promise<void>;
let handleIncidentRemediationRequest: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedUrl: URL
) => Promise<void>;

if (incidentStore) {
    const incidentService = createIncidentService({
        incidentStore,
        alertRouter: incidentAlertRouter,
    });
    ({
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
    }));
} else {
    const logUnavailableRoute = (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        routeLabel: string
    ) => {
        logger.warn('Incident subsystem unavailable route hit', { routeLabel });
        writeIncidentUnavailable(res);
        logRequest(req, res, `${routeLabel} unavailable`);
    };

    handleIncidentReportRequest = async (req, res) =>
        logUnavailableRoute(req, res, 'incident report');
    handleIncidentListRequest = async (req, res) =>
        logUnavailableRoute(req, res, 'incident list');
    handleIncidentDetailRequest = async (req, res) =>
        logUnavailableRoute(req, res, 'incident detail');
    handleIncidentStatusRequest = async (req, res) =>
        logUnavailableRoute(req, res, 'incident status');
    handleIncidentNotesRequest = async (req, res) =>
        logUnavailableRoute(req, res, 'incident notes');
    handleIncidentRemediationRequest = async (req, res) =>
        logUnavailableRoute(req, res, 'incident remediation');
}
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
// Chat is the backend-standardized conversation interface (adapter-facing, Turnstile + rate-limited for public web calls).
const executionContractTrustGraphRuntimeOptions =
    resolveExecutionContractTrustGraphRuntimeOptions(
        runtimeConfig.executionContractTrustGraph
    );

const handleChatRequest = createChatHandler({
    generationRuntime,
    alertRouter: incidentAlertRouter,
    weatherForecastTool: weatherForecastTool ?? undefined,
    ipRateLimiter,
    sessionRateLimiter,
    serviceRateLimiter,
    storeTrace: storeTraceWithStore,
    logRequest,
    buildResponseMetadata,
    maxChatBodyBytes: runtimeConfig.reflect.maxBodyBytes,
    executionContractTrustGraph: executionContractTrustGraphRuntimeOptions,
});
const { dispatchHttpRoute, dispatchUpgradeRoute } = createRouteDispatcher({
    handlers: {
        handleWebhookRequest,
        handleIncidentListRequest,
        handleIncidentReportRequest,
        handleInternalTextRequest,
        handleInternalImageRequest,
        handleInternalVoiceTtsRequest,
        handleIncidentStatusRequest,
        handleIncidentNotesRequest,
        handleIncidentRemediationRequest,
        handleIncidentDetailRequest,
        handleTraceUpsertRequest,
        handleTraceCardCreateRequest,
        handleTraceCardFromTraceRequest,
        handleTraceCardAssetRequest,
        handleTraceRequest,
        handleChatRequest,
    },
    onTraceRouteMatched: (pathname) => {
        logger.debug(`Trace route matched: ${pathname}`);
    },
});
const app = createExpressApp({
    dispatchHttpRoute,
    normalizePathname,
    handleRuntimeConfigRequest,
    handleChatProfilesRequest,
    handleBlogIndexRequest,
    handleBlogPostRequest,
    blogReadRateLimiter,
    handleStaticTransportRequest,
    resolveAsset,
    mimeMap,
    frameAncestors: runtimeConfig.csp.frameAncestors,
    logRequest,
});

// --- HTTP server ---
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
    handleUpgradeBoundary({
        req,
        socket,
        head,
        normalizePathname,
        dispatchUpgradeRoute,
        handleInternalVoiceRealtimeUpgrade,
        logUpgradeError: (error) => {
            logger.error(
                `Failed to process websocket upgrade: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        },
    });
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
