/**
 * @description: Loads and validates backend model profile catalog settings from env and YAML.
 * @footnote-scope: utility
 * @footnote-module: BackendModelProfilesSection
 * @footnote-risk: high - Invalid catalog handling can misroute model execution or disable safe fallbacks.
 * @footnote-ethics: high - Model profile capabilities influence retrieval behavior and transparency expectations.
 */

import fs from 'node:fs';
import path from 'node:path';
import { envDefaultValues } from '@footnote/config-spec';
import { ModelProfileSchema } from '@footnote/contracts';
import yaml from 'js-yaml';
import { parseOptionalTrimmedString } from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

const DEFAULT_CATALOG_RELATIVE_PATH =
    'packages/backend/src/config/model-profiles.defaults.yaml';

const resolveCatalogPath = (
    projectRoot: string,
    configuredPath: string | null
): string =>
    configuredPath
        ? path.isAbsolute(configuredPath)
            ? configuredPath
            : path.resolve(projectRoot, configuredPath)
        : path.resolve(projectRoot, DEFAULT_CATALOG_RELATIVE_PATH);

const readCatalogYaml = (
    absolutePath: string,
    warn: WarningSink
): unknown | null => {
    try {
        const fileContents = fs.readFileSync(absolutePath, 'utf-8');
        return yaml.load(fileContents);
    } catch (error) {
        warn(
            `Could not load model profile catalog "${absolutePath}". ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
    }
};

const tryExtractCatalogEntries = (payload: unknown): unknown[] | null => {
    if (Array.isArray(payload)) {
        return payload;
    }

    if (
        payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        Array.isArray((payload as { profiles?: unknown[] }).profiles)
    ) {
        return (payload as { profiles: unknown[] }).profiles;
    }

    return null;
};

const parseBooleanFlag = (value: string | undefined): boolean => {
    if (typeof value !== 'string') {
        return false;
    }

    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

const parseUrlHostname = (value: string): string | null => {
    try {
        return new URL(value).hostname.toLowerCase();
    } catch {
        return null;
    }
};

const isLocalOllamaHost = (hostname: string): boolean =>
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === 'host.docker.internal';

const buildProviderAvailability = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): Record<'openai' | 'ollama', boolean> => {
    const openAiEnabled = Boolean(
        parseOptionalTrimmedString(env.OPENAI_API_KEY)
    );
    const ollamaBaseUrl = parseOptionalTrimmedString(env.OLLAMA_BASE_URL);
    const ollamaLocalInferenceEnabled = parseBooleanFlag(
        env.OLLAMA_LOCAL_INFERENCE_ENABLED
    );

    let ollamaEnabled = false;
    if (ollamaBaseUrl) {
        const hostname = parseUrlHostname(ollamaBaseUrl);
        if (!hostname) {
            warn(
                `Ignoring OLLAMA_BASE_URL "${ollamaBaseUrl}" because it is not a valid URL.`
            );
        } else if (
            isLocalOllamaHost(hostname) &&
            !ollamaLocalInferenceEnabled
        ) {
            warn(
                `OLLAMA_BASE_URL points to local inference host "${hostname}" but OLLAMA_LOCAL_INFERENCE_ENABLED is not true. Ollama profiles will be disabled.`
            );
        } else {
            ollamaEnabled = true;
        }
    }

    return {
        openai: openAiEnabled,
        ollama: ollamaEnabled,
    };
};

const applyProviderAvailability = (
    catalog: RuntimeConfig['modelProfiles']['catalog'],
    providerAvailability: Record<'openai' | 'ollama', boolean>,
    warn: WarningSink
): RuntimeConfig['modelProfiles']['catalog'] =>
    catalog.map((profile) => {
        if (!profile.enabled) {
            return profile;
        }

        if (!providerAvailability[profile.provider]) {
            warn(
                `Disabling model profile "${profile.id}" because provider "${profile.provider}" is not configured.`
            );
            return {
                ...profile,
                enabled: false,
            };
        }

        return profile;
    });

const parseCatalogEntries = (
    entries: unknown[],
    sourcePath: string,
    warn: WarningSink
): RuntimeConfig['modelProfiles']['catalog'] => {
    const parsedCatalog: RuntimeConfig['modelProfiles']['catalog'] = [];
    const seenIds = new Set<string>();

    entries.forEach((entry, index) => {
        const parsed = ModelProfileSchema.safeParse(entry);
        if (!parsed.success) {
            warn(
                `Ignoring invalid model profile at "${sourcePath}" index ${index}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`
            );
            return;
        }

        if (seenIds.has(parsed.data.id)) {
            warn(
                `Ignoring duplicate model profile id "${parsed.data.id}" from "${sourcePath}".`
            );
            return;
        }

        seenIds.add(parsed.data.id);
        parsedCatalog.push(parsed.data);
    });

    return parsedCatalog;
};

/**
 * Builds the model profile section used by backend model resolution.
 *
 * Loading is fail-open:
 * - missing/invalid YAML warns and falls back to bundled defaults
 * - invalid profile entries are skipped, not fatal
 */
export const buildModelProfilesSection = (
    env: NodeJS.ProcessEnv,
    projectRoot: string,
    warn: WarningSink
): RuntimeConfig['modelProfiles'] => {
    const configuredCatalogPath = parseOptionalTrimmedString(
        env.MODEL_PROFILE_CATALOG_PATH
    );
    const bundledCatalogPath = path.resolve(
        projectRoot,
        DEFAULT_CATALOG_RELATIVE_PATH
    );
    const preferredCatalogPath = resolveCatalogPath(
        projectRoot,
        configuredCatalogPath
    );
    const defaultProfileId =
        parseOptionalTrimmedString(env.DEFAULT_PROFILE_ID) ||
        envDefaultValues.DEFAULT_PROFILE_ID;
    // Response generation fallback profile.
    // Used when callers provide no selector or an invalid/disabled selector.
    const plannerProfileId =
        parseOptionalTrimmedString(env.PLANNER_PROFILE_ID) ||
        envDefaultValues.PLANNER_PROFILE_ID;
    // Planner execution profile.
    // Kept separate so planner cost/latency can be tuned independently.

    let effectiveCatalogPath = preferredCatalogPath;
    let entries: unknown[] | null = null;

    const preferredPayload = readCatalogYaml(preferredCatalogPath, warn);
    if (preferredPayload !== null) {
        entries = tryExtractCatalogEntries(preferredPayload);
        if (entries === null) {
            warn(
                `Model profile catalog "${preferredCatalogPath}" must be a YAML list or object with a "profiles" array.`
            );
        }
    }

    const shouldTryBundledFallback =
        (preferredPayload === null || entries === null) &&
        preferredCatalogPath !== bundledCatalogPath;
    if (shouldTryBundledFallback) {
        const bundledPayload = readCatalogYaml(bundledCatalogPath, warn);
        if (bundledPayload !== null) {
            const bundledEntries = tryExtractCatalogEntries(bundledPayload);
            if (bundledEntries !== null) {
                entries = bundledEntries;
                effectiveCatalogPath = bundledCatalogPath;
                warn(
                    `Using bundled model profile catalog fallback "${bundledCatalogPath}" instead of "${preferredCatalogPath}".`
                );
            } else {
                warn(
                    `Bundled model profile catalog "${bundledCatalogPath}" must be a YAML list or object with a "profiles" array. Using an empty catalog.`
                );
                entries = [];
                effectiveCatalogPath = bundledCatalogPath;
            }
        } else if (entries === null) {
            entries = [];
            effectiveCatalogPath = preferredCatalogPath;
        }
    }

    if (entries === null) {
        entries = [];
        warn(
            `Model profile catalog "${effectiveCatalogPath}" must be a YAML list or object with a "profiles" array. Using an empty catalog.`
        );
    }

    const parsedCatalog = parseCatalogEntries(
        entries,
        effectiveCatalogPath,
        warn
    );
    const providerAvailability = buildProviderAvailability(env, warn);
    const catalog = applyProviderAvailability(
        parsedCatalog,
        providerAvailability,
        warn
    );

    return {
        defaultProfileId,
        plannerProfileId,
        catalogPath: effectiveCatalogPath,
        catalog,
    };
};
