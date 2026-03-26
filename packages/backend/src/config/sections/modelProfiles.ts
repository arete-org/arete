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

    const catalog = parseCatalogEntries(entries, effectiveCatalogPath, warn);

    return {
        defaultProfileId,
        plannerProfileId,
        catalogPath: effectiveCatalogPath,
        catalog,
    };
};
