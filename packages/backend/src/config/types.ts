/**
 * @description: Shared backend config types used by the runtime config builders.
 * @footnote-scope: utility
 * @footnote-module: BackendRuntimeConfigTypes
 * @footnote-risk: medium - Wrong config typing can hide missing sections or invalid defaults.
 * @footnote-ethics: medium - These types shape safety-relevant runtime behavior.
 */

import type {
    ConfiguredProviderModel,
    SupportedLogLevel,
    SupportedNodeEnv,
    SupportedReasoningEffort,
    SupportedVerbosity,
} from '@footnote/contracts/providers';

export type WarningSink = (message: string) => void;

export type RateLimitConfig = {
    limit: number;
    windowMs: number;
};

export type RuntimeConfig = {
    runtime: {
        nodeEnv: SupportedNodeEnv;
        isProduction: boolean;
        isDevelopment: boolean;
        flyAppName: string | null;
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
        defaultReasoningEffort: SupportedReasoningEffort;
        defaultVerbosity: SupportedVerbosity;
        defaultChannelContext: { channelId: string };
        requestTimeoutMs: number;
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
        reflectService: RateLimitConfig;
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
};
