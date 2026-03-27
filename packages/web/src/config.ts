/**
 * @description: Loads runtime configuration for the web app from the backend.
 * @footnote-scope: utility
 * @footnote-module: RuntimeConfigLoader
 * @footnote-risk: low - Config fetch failures only disable optional client features.
 * @footnote-ethics: low - Exposes only non-sensitive configuration to the client.
 */
import type { GetRuntimeConfigResponse } from '@footnote/contracts/web';
import { api } from './utils/api';

/**
 * Public runtime config shape the web app expects from the backend.
 */
export type RuntimeConfig = GetRuntimeConfigResponse;

/**
 * Safe fallback used when the backend config endpoint is unavailable.
 */
const DEFAULT_CONFIG: RuntimeConfig = {
    turnstileSiteKey: '',
};

let cachedConfig: RuntimeConfig | null = null;
let inFlightConfig: Promise<RuntimeConfig> | null = null;

/**
 * Narrows unknown API payloads into the small client-safe config surface the
 * web app actually uses.
 */
const normalizeConfig = (payload: unknown): RuntimeConfig => {
    if (!payload || typeof payload !== 'object') {
        return DEFAULT_CONFIG;
    }

    const raw = payload as { turnstileSiteKey?: unknown };
    return {
        turnstileSiteKey:
            typeof raw.turnstileSiteKey === 'string'
                ? raw.turnstileSiteKey
                : '',
    };
};

/**
 * Loads runtime config once and reuses the same promise for concurrent callers.
 */
export const loadRuntimeConfig = async (): Promise<RuntimeConfig> => {
    if (cachedConfig) {
        return cachedConfig;
    }

    if (!inFlightConfig) {
        inFlightConfig = api
            .getRuntimeConfig()
            .then((payload) => normalizeConfig(payload))
            .catch(() => DEFAULT_CONFIG)
            .then((config) => {
                cachedConfig = config;
                return config;
            });
    }

    return inFlightConfig;
};

/**
 * Small namespace-style export used by existing web code.
 */
export const runtimeConfig = {
    load: loadRuntimeConfig,
};
