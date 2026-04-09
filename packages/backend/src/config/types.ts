/**
 * @description: Defines the backend config shapes returned by the startup config builders.
 * @footnote-scope: utility
 * @footnote-module: BackendRuntimeConfigTypes
 * @footnote-risk: medium - Wrong config typing can hide missing sections or invalid defaults.
 * @footnote-ethics: medium - These types shape safety-relevant runtime behavior.
 */

import type {
    ConfiguredProviderModel,
    SupportedLogLevel,
    SupportedNodeEnv,
    SupportedOpenAIRealtimeModel,
    SupportedOpenAITtsVoice,
    SupportedReasoningEffort,
    SupportedVerbosity,
} from '@footnote/contracts/providers';
import type { ModelProfile } from '@footnote/contracts';
import type { BotProfileConfig } from './profile.js';

/**
 * Sink used by config builders to report ignored or risky env values without
 * throwing immediately.
 */
export type WarningSink = (message: string) => void;

/**
 * Shared shape for "limit per window" settings used by rate-limited endpoints.
 */
export type RateLimitConfig = {
    limit: number;
    windowMs: number;
};

/**
 * Canonical backend runtime config assembled from env parsing helpers.
 */
export type RuntimeConfig = {
    runtime: {
        nodeEnv: SupportedNodeEnv;
        isProduction: boolean;
        isDevelopment: boolean;
        flyAppName: string | null;
        promptConfigPath: string | null;
        projectRoot: string;
    };
    server: {
        dataDir: string;
        host: string;
        port: number;
        trustProxy: boolean;
    };
    openai: {
        apiKey: string | null;
        defaultModel: ConfiguredProviderModel;
        plannerStructuredOutputEnabled: boolean;
        plannerAllowTextJsonCompatibilityFallback: boolean;
        defaultRealtimeModel: SupportedOpenAIRealtimeModel;
        defaultRealtimeVoice: SupportedOpenAITtsVoice;
        defaultReasoningEffort: SupportedReasoningEffort;
        defaultVerbosity: SupportedVerbosity;
        defaultChannelContext: { channelId: string };
        requestTimeoutMs: number;
    };
    ollama: {
        baseUrl: string | null;
        apiKey: string | null;
        localInferenceEnabled: boolean;
    };
    modelProfiles: {
        defaultProfileId: string;
        plannerProfileId: string;
        catalogPath: string;
        catalog: ModelProfile[];
    };
    voltagent: {
        publicKey: string | null;
        secretKey: string | null;
        observabilityEnabled: boolean;
    };
    cors: {
        allowedOrigins: string[];
    };
    csp: {
        frameAncestors: string[];
    };
    reflect: {
        serviceToken: string | null;
        maxBodyBytes: number;
    };
    trace: {
        apiToken: string | null;
        maxBodyBytes: number;
    };
    chatWorkflow: {
        profileId: 'bounded-review' | 'generate-only';
        reviewLoopEnabled: boolean;
        maxIterations: number;
        maxDurationMs: number;
    };
    executionContractTrustGraph: {
        enabled: boolean;
        killSwitchExternalRetrieval: boolean;
        policyId: string;
        timeoutMs: number;
        maxCalls: number;
        adapter: {
            mode: 'none' | 'stub' | 'http';
            endpointUrl: string | null;
            apiToken: string | null;
            configRef: string | null;
            stubMode: 'success' | 'failure' | 'timeout' | 'poisoned';
        };
        ownership: {
            bindingMode: 'none' | 'http';
            validatorId: string;
            endpointUrl: string | null;
            apiToken: string | null;
        };
    };
    turnstile: {
        secretKey: string | null;
        siteKey: string | null;
        allowedHostnames: string[];
        enabled: boolean;
    };
    rateLimits: {
        web: {
            ip: RateLimitConfig;
            session: RateLimitConfig;
        };
        chatService: RateLimitConfig;
        traceApi: RateLimitConfig;
    };
    webhook: {
        secret: string | null;
        repository: string;
        maxBodyBytes: number;
    };
    storage: {
        provenanceSqlitePath: string | null;
        incidentPseudonymizationSecret: string | null;
        incidentSqlitePath: string | null;
    };
    logging: {
        directory: string;
        level: SupportedLogLevel;
    };
    litestream: {
        replicaUrl: string | null;
        latestSnapshotAt: string | null;
    };
    alerts: {
        discord: {
            enabled: boolean;
            botToken: string | null;
            channelId: string | null;
            roleId: string | null;
        };
        email: {
            enabled: boolean;
            smtpHost: string | null;
            smtpPort: number;
            smtpSecure: boolean;
            smtpUsername: string | null;
            smtpPassword: string | null;
            from: string | null;
            to: string[];
        };
    };
    profile: BotProfileConfig;
};
