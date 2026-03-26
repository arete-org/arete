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
        defaultRealtimeModel: SupportedOpenAIRealtimeModel;
        defaultRealtimeVoice: SupportedOpenAITtsVoice;
        defaultReasoningEffort: SupportedReasoningEffort;
        defaultVerbosity: SupportedVerbosity;
        defaultChannelContext: { channelId: string };
        requestTimeoutMs: number;
    };
    modelProfiles: {
        defaultProfileId: string;
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
    profile: BotProfileConfig;
};
