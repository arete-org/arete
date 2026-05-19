/**
 * @description: Loads canonical server settings YAML and enforces config-source boundaries.
 * @footnote-scope: core
 * @footnote-module: BackendServerSettings
 * @footnote-risk: high - Incorrect source-boundary parsing can silently apply unsafe runtime config.
 * @footnote-ethics: medium - Clear source separation protects operator intent and secret-handling governance.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
    envConfigSourceByKey,
    envDefaultValues,
    envSpecByKey,
} from '@footnote/config-spec';
import type { WarningSink } from './types.js';

type YamlModule = { load(input: string): unknown };
const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as YamlModule;

const DEFAULT_SERVER_SETTINGS_PATH = '/data/config/footnote.server.yaml';
const LEGACY_LOCAL_NODES_ENV_KEY = 'LOCAL_DISCORD_NODES_CONFIG_PATH';
type CanonicalLocalNodeList = NonNullable<
    FootnoteServerSettings['settings']['localNodes']
>['nodes'];

type SettingsScalar = string | number | boolean | string[];
type SettingsMap = Record<string, SettingsScalar>;

export type FootnoteServerSettings = {
    settings: {
        env?: SettingsMap;
        localNodes?: {
            nodes: Array<{
                id: string;
                enabled?: boolean;
                required?: boolean;
                credentials: {
                    discordTokenEnv?: string;
                    discordClientIdEnv?: string;
                    discordGuildIdsEnv?: string;
                    discordGuildIdEnv?: string;
                    discordUserIdEnv?: string;
                    incidentSecretEnv?: string;
                };
                profile: {
                    id: string;
                    displayName: string;
                    overlayPath?: string;
                    mentionAliases?: string[];
                };
            }>;
        };
    };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const normalizePath = (value: string | undefined): string =>
    value?.trim() || DEFAULT_SERVER_SETTINGS_PATH;

const serializeValue = (value: SettingsScalar): string =>
    Array.isArray(value) ? value.join(',') : String(value);

const validateEnvSetting = (key: string, value: unknown): SettingsScalar => {
    const spec = envSpecByKey[key as keyof typeof envSpecByKey];
    if (!spec) {
        throw new Error(`settings.env.${key} is not a supported server key.`);
    }
    if (
        envConfigSourceByKey[key as keyof typeof envConfigSourceByKey] !==
        'settings_yaml'
    ) {
        throw new Error(
            `settings.env.${key} is not YAML-configurable (source: ${envConfigSourceByKey[key as keyof typeof envConfigSourceByKey]}).`
        );
    }
    if (spec.secret) {
        throw new Error(
            `settings.env.${key} must not contain secret values. Use env-only secret wiring.`
        );
    }

    switch (spec.kind) {
        case 'boolean':
            if (typeof value !== 'boolean') {
                throw new Error(`settings.env.${key} must be a boolean.`);
            }
            return value;
        case 'integer':
            if (
                typeof value !== 'number' ||
                Number.isNaN(value) ||
                !Number.isInteger(value)
            ) {
                throw new Error(`settings.env.${key} must be an integer.`);
            }
            return value;
        case 'number':
            if (typeof value !== 'number' || Number.isNaN(value)) {
                throw new Error(`settings.env.${key} must be a number.`);
            }
            return value;
        case 'csv':
            if (Array.isArray(value)) {
                if (!value.every((entry) => typeof entry === 'string')) {
                    throw new Error(
                        `settings.env.${key} array entries must be strings.`
                    );
                }
                return value;
            }
            if (typeof value !== 'string') {
                throw new Error(
                    `settings.env.${key} must be a comma-separated string or string array.`
                );
            }
            return value;
        default:
            if (typeof value !== 'string') {
                throw new Error(`settings.env.${key} must be a string.`);
            }
            return value;
    }
};

/**
 * `loadServerSettings` is the canonical authority boundary reader for server
 * runtime settings YAML.
 *
 * Inputs:
 * - `env`: process environment snapshot used only for bootstrap lookup and
 *   legacy-key warning checks.
 * - `warn`: warning sink for non-fatal boundary and fail-open notices.
 *
 * Returns:
 * - `settingsPath`: resolved canonical YAML path.
 * - `yamlSettings`: parsed canonical settings object or `null` when YAML is
 *   missing.
 * - `yamlEnv`: validated non-secret `settings.env` values converted to env
 *   string form for downstream section parsers.
 *
 * Failure policy:
 * - Missing YAML (`ENOENT`) is fail-open with warning (except suppressed under
 *   `NODE_ENV=test`): callers should continue with defaults.
 * - Present but invalid YAML is fail-closed via thrown errors with actionable
 *   messages.
 *
 * Security and trust assumptions:
 * - Secret/bootstrap keys are never accepted from `settings.env`.
 * - YAML values are treated as operator-controlled non-secret runtime intent.
 * - Warning side effects are emitted through `warn` for deprecated env usage
 *   and fail-open conditions.
 */
export const loadServerSettings = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): {
    settingsPath: string;
    yamlSettings: FootnoteServerSettings | null;
    yamlEnv: NodeJS.ProcessEnv;
} => {
    const settingsPath = normalizePath(env.FOOTNOTE_SERVER_SETTINGS_PATH);
    if (typeof env[LEGACY_LOCAL_NODES_ENV_KEY] === 'string') {
        warn(
            `${LEGACY_LOCAL_NODES_ENV_KEY} is unsupported. Define local nodes directly under settings.localNodes.nodes in footnote.server.yaml. Ignoring env value.`
        );
    }

    let rawText: string;
    try {
        rawText = fs.readFileSync(settingsPath, 'utf8');
    } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === 'ENOENT') {
            if (env.NODE_ENV !== 'test') {
                warn(
                    `Server settings YAML not found at ${settingsPath}. Starting with defaults and env-only secrets/bootstrap wiring.`
                );
            }
            return { settingsPath, yamlSettings: null, yamlEnv: {} };
        }
        throw new Error(
            `Failed to read server settings YAML at ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
        );
    }

    const parsed = yaml.load(rawText);
    if (!isRecord(parsed) || !isRecord(parsed.settings)) {
        throw new Error(
            `Invalid server settings YAML at ${settingsPath}: root must contain a "settings" object.`
        );
    }

    const rawLocalNodes = parsed.settings.localNodes;
    if (rawLocalNodes !== undefined && !isRecord(rawLocalNodes)) {
        throw new Error(
            `Invalid server settings YAML at ${settingsPath}: settings.localNodes must be an object.`
        );
    }
    const localNodes = rawLocalNodes as Record<string, unknown> | undefined;
    if (localNodes && 'configPath' in localNodes) {
        throw new Error(
            `Invalid server settings YAML at ${settingsPath}: settings.localNodes.configPath is removed. Define nodes directly under settings.localNodes.nodes.`
        );
    }
    if (
        localNodes &&
        localNodes.nodes !== undefined &&
        !Array.isArray(localNodes.nodes)
    ) {
        throw new Error(
            `Invalid server settings YAML at ${settingsPath}: settings.localNodes.nodes must be an array when provided.`
        );
    }

    const yamlEnv: NodeJS.ProcessEnv = {};
    if (parsed.settings.env !== undefined) {
        if (!isRecord(parsed.settings.env)) {
            throw new Error(
                `Invalid server settings YAML at ${settingsPath}: settings.env must be an object when provided.`
            );
        }

        for (const [key, rawValue] of Object.entries(parsed.settings.env)) {
            const normalized = validateEnvSetting(key, rawValue);
            yamlEnv[key] = serializeValue(normalized);
        }
    }

    const yamlSettings: FootnoteServerSettings = {
        settings: {
            env: isRecord(parsed.settings.env)
                ? (parsed.settings.env as SettingsMap)
                : undefined,
            localNodes: localNodes
                ? {
                      nodes: Array.isArray(localNodes.nodes)
                          ? (localNodes.nodes as CanonicalLocalNodeList)
                          : [],
                  }
                : undefined,
        },
    };

    return { settingsPath, yamlSettings, yamlEnv };
};

const getLegacySettingsEnvKeys = (): string[] =>
    Object.entries(envConfigSourceByKey)
        .filter(([, source]) => source === 'settings_yaml')
        .map(([key]) => key);

const LEGACY_SETTINGS_ENV_KEYS = getLegacySettingsEnvKeys();

/**
 * `buildEffectiveConfigEnv` builds the effective runtime env snapshot used by
 * backend config sections.
 *
 * Inputs:
 * - `processEnv`: raw process env containing secrets/bootstrap and possible
 *   legacy non-secret keys.
 * - `yamlEnv`: validated non-secret settings values from canonical YAML.
 * - `warn`: warning sink used when deprecated non-secret env overrides are
 *   detected and ignored.
 *
 * Returns:
 * - a merged env object where:
 *   - `secret_env` and `bootstrap_env` values come only from `processEnv`
 *   - `settings_yaml` values come only from `yamlEnv`
 *
 * Behavior:
 * - Fail-open for legacy non-secret env keys: emits warnings and ignores them.
 * - No file I/O and no thrown errors expected under normal inputs.
 */
export const buildEffectiveConfigEnv = (
    processEnv: NodeJS.ProcessEnv,
    yamlEnv: NodeJS.ProcessEnv,
    warn: WarningSink
): NodeJS.ProcessEnv => {
    const effectiveEnv: NodeJS.ProcessEnv = {};

    for (const [key, source] of Object.entries(envConfigSourceByKey)) {
        if (source === 'settings_yaml') {
            continue;
        }
        const value = processEnv[key];
        if (typeof value === 'string') {
            effectiveEnv[key] = value;
        }
    }

    for (const [key, value] of Object.entries(yamlEnv)) {
        effectiveEnv[key] = value;
    }

    for (const key of LEGACY_SETTINGS_ENV_KEYS) {
        if (typeof processEnv[key] !== 'string') {
            continue;
        }
        warn(
            `Ignoring deprecated env key ${key}. Non-secret runtime settings must come from footnote.server.yaml.`
        );
    }

    effectiveEnv.FOOTNOTE_SERVER_SETTINGS_PATH =
        processEnv.FOOTNOTE_SERVER_SETTINGS_PATH ??
        envDefaultValues.FOOTNOTE_SERVER_SETTINGS_PATH;

    return effectiveEnv;
};
