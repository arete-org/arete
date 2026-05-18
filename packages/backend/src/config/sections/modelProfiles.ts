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
import {
    ModelProfileSchema,
    StepRoutingChainsConfigSchema,
    type WorkflowModeProfileId,
    type StepRoutingChainsConfig,
} from '@footnote/contracts';
import yaml from 'js-yaml';
import { parseBooleanFlag, parseOptionalTrimmedString } from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

const DEFAULT_CATALOG_RELATIVE_PATH =
    'packages/backend/src/config/model-profiles.defaults.yaml';

const DEFAULT_STEP_CHAINS: StepRoutingChainsConfig = {
    balanced: {
        planner: ['openai-json-optimized', 'ollama-text-gptoss'],
        generate: [{ chooseOne: ['free-ollama-style'] }, 'openai-text-medium'],
        assess: ['openai-json-optimized', 'ollama-text-gptoss'],
    },
    grounded: {
        planner: ['openai-json-optimized', 'ollama-text-gptoss'],
        generate: ['openai-text-medium', { chooseOne: ['free-ollama-style'] }],
        assess: ['openai-json-optimized', 'ollama-text-gptoss'],
    },
};

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

type RawModelCatalogPayload = {
    profiles?: unknown;
    pools?: unknown;
    stepRoutingChains?: unknown;
};

const tryExtractCatalogPayload = (
    payload: unknown
): RawModelCatalogPayload | null => {
    if (Array.isArray(payload)) {
        return {
            profiles: payload,
        };
    }

    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const candidate = payload as RawModelCatalogPayload;
        return {
            profiles: candidate.profiles,
            pools: candidate.pools,
            stepRoutingChains: candidate.stepRoutingChains,
        };
    }

    return null;
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

const parsePools = (
    poolsValue: unknown,
    profileIds: Set<string>,
    sourcePath: string,
    warn: WarningSink
): Record<string, string[]> => {
    if (
        !poolsValue ||
        typeof poolsValue !== 'object' ||
        Array.isArray(poolsValue)
    ) {
        return {};
    }

    const pools: Record<string, string[]> = {};
    for (const [poolName, poolIds] of Object.entries(
        poolsValue as Record<string, unknown>
    )) {
        if (!Array.isArray(poolIds)) {
            warn(
                `Ignoring pools.${poolName} in "${sourcePath}" because it is not a list.`
            );
            continue;
        }
        const normalized = poolIds.filter(
            (value): value is string =>
                typeof value === 'string' && value.trim().length > 0
        );
        const valid = normalized.filter((profileId) => {
            if (profileIds.has(profileId)) {
                return true;
            }
            warn(
                `Ignoring unknown profile "${profileId}" in pools.${poolName} from "${sourcePath}".`
            );
            return false;
        });
        if (valid.length === 0) {
            warn(
                `Ignoring empty/invalid pools.${poolName} from "${sourcePath}".`
            );
            continue;
        }
        pools[poolName] = valid;
    }

    return pools;
};

const validateStepRoutingChains = (
    value: unknown,
    pools: Record<string, string[]>,
    profileIds: Set<string>,
    sourcePath: string,
    warn: WarningSink
): StepRoutingChainsConfig => {
    if (value === undefined) {
        return DEFAULT_STEP_CHAINS;
    }
    const parsed = StepRoutingChainsConfigSchema.safeParse(value);
    if (!parsed.success) {
        warn(
            `Invalid stepRoutingChains in "${sourcePath}". Using defaults. ${parsed.error.issues.map((issue) => issue.message).join('; ')}`
        );
        return DEFAULT_STEP_CHAINS;
    }

    const resolved = JSON.parse(
        JSON.stringify(parsed.data)
    ) as StepRoutingChainsConfig;
    const modes: WorkflowModeProfileId[] = ['balanced', 'grounded'];
    for (const mode of modes) {
        const steps: Array<'planner' | 'generate' | 'assess'> = [
            'planner',
            'generate',
            'assess',
        ];
        for (const step of steps) {
            resolved[mode][step] = resolved[mode][step].filter((entry) => {
                if (typeof entry === 'string') {
                    if (profileIds.has(entry)) {
                        return true;
                    }
                    const pooled = pools[entry];
                    if (pooled) {
                        return true;
                    }
                    warn(
                        `Skipping unknown stepRoutingChains.${mode}.${step} entry "${entry}" from "${sourcePath}".`
                    );
                    return false;
                }

                const candidateIds = entry.chooseOne.filter((id) => {
                    if (profileIds.has(id) || pools[id]) {
                        return true;
                    }
                    warn(
                        `Skipping unknown chooseOne candidate "${id}" in stepRoutingChains.${mode}.${step} from "${sourcePath}".`
                    );
                    return false;
                });
                entry.chooseOne = candidateIds;
                if (entry.chooseOne.length === 0) {
                    warn(
                        `Skipping empty chooseOne candidate list in stepRoutingChains.${mode}.${step} from "${sourcePath}".`
                    );
                    return false;
                }
                return true;
            });

            if (resolved[mode][step].length === 0) {
                resolved[mode][step] = [...DEFAULT_STEP_CHAINS[mode][step]];
            }
        }
    }

    return resolved;
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
    const plannerProfileId =
        parseOptionalTrimmedString(env.PLANNER_PROFILE_ID) ||
        envDefaultValues.PLANNER_PROFILE_ID;

    let effectiveCatalogPath = preferredCatalogPath;
    let payload: RawModelCatalogPayload | null = null;

    const preferredPayload = readCatalogYaml(preferredCatalogPath, warn);
    if (preferredPayload !== null) {
        payload = tryExtractCatalogPayload(preferredPayload);
        const entries = Array.isArray(payload?.profiles)
            ? payload.profiles
            : null;
        if (entries === null) {
            warn(
                `Model profile catalog "${preferredCatalogPath}" must be a YAML list or object with a "profiles" array.`
            );
            payload = null;
        }
    }

    const shouldTryBundledFallback =
        (preferredPayload === null || payload === null) &&
        preferredCatalogPath !== bundledCatalogPath;
    if (shouldTryBundledFallback) {
        const bundledPayload = readCatalogYaml(bundledCatalogPath, warn);
        if (bundledPayload !== null) {
            const extractedPayload = tryExtractCatalogPayload(bundledPayload);
            if (Array.isArray(extractedPayload?.profiles)) {
                payload = extractedPayload;
                effectiveCatalogPath = bundledCatalogPath;
                warn(
                    `Using bundled model profile catalog fallback "${bundledCatalogPath}" instead of "${preferredCatalogPath}".`
                );
            } else {
                warn(
                    `Bundled model profile catalog "${bundledCatalogPath}" must be a YAML list or object with a "profiles" array. Using an empty catalog.`
                );
                payload = { profiles: [] };
                effectiveCatalogPath = bundledCatalogPath;
            }
        } else if (payload === null) {
            payload = { profiles: [] };
            effectiveCatalogPath = preferredCatalogPath;
        }
    }

    if (payload === null) {
        payload = { profiles: [] };
        warn(
            `Model profile catalog "${effectiveCatalogPath}" must be a YAML list or object with a "profiles" array. Using an empty catalog.`
        );
    }

    const parsedCatalog = parseCatalogEntries(
        Array.isArray(payload.profiles) ? payload.profiles : [],
        effectiveCatalogPath,
        warn
    );
    const providerAvailability = buildProviderAvailability(env, warn);
    const catalog = applyProviderAvailability(
        parsedCatalog,
        providerAvailability,
        warn
    );
    const profileIds = new Set(catalog.map((profile) => profile.id));
    const pools = parsePools(
        payload.pools,
        profileIds,
        effectiveCatalogPath,
        warn
    );
    const stepRoutingChains = validateStepRoutingChains(
        payload.stepRoutingChains,
        pools,
        profileIds,
        effectiveCatalogPath,
        warn
    );

    return {
        defaultProfileId,
        plannerProfileId,
        catalogPath: effectiveCatalogPath,
        catalog,
        pools,
        stepRoutingChains,
    };
};
