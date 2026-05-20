/**
 * @description: Loads canonical footnote.yaml settings and enforces source boundaries.
 * @footnote-scope: core
 * @footnote-module: BackendSettingsLoader
 * @footnote-risk: high - Misparsed settings can route runtime controls to unintended behavior.
 * @footnote-ethics: medium - Clear secret/runtime boundaries protect operator intent and governance posture.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { envConfigSourceByKey, envDefaultValues } from '@footnote/config-spec';
import {
    envPathSourceEntries,
    settingsSpecEntries,
    type SettingsValueKind,
} from './settings-spec.js';
import type { WarningSink } from './types.js';

type YamlModule = { load(input: string): unknown };
const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as YamlModule;

const DEFAULT_SETTINGS_PATH = '/data/config/footnote.yaml';
const KEBAB_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type SettingsScalar = string | number | boolean | string[];
type SettingsMap = Record<string, SettingsScalar>;

type CanonicalDiscordBot = {
    id?: string;
    enabled?: boolean;
    required?: boolean;
    credentials?: {
        discordTokenEnv?: string;
        discordClientIdEnv?: string;
        discordGuildIdsEnv?: string;
        discordUserIdEnv?: string;
        incidentSecretEnv?: string;
    };
    profile?: {
        id?: string;
        displayName?: string;
        overlayPath?: string;
        mentionAliases?: string[];
    };
};

export type FootnoteSettings = {
    version: number;
    'discord-bots': CanonicalDiscordBot[];
    settingsEnv: SettingsMap;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizePath = (value: string | undefined): string =>
    value?.trim() || DEFAULT_SETTINGS_PATH;

const validateKebabCaseKeys = (value: unknown, pointer = 'root'): void => {
    if (Array.isArray(value)) {
        value.forEach((entry, index) =>
            validateKebabCaseKeys(entry, `${pointer}[${index}]`)
        );
        return;
    }
    if (!isRecord(value)) {
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        if (!KEBAB_KEY_PATTERN.test(key)) {
            throw new Error(
                `Invalid key "${key}" at ${pointer}. Use kebab-case keys in footnote.yaml.`
            );
        }
        validateKebabCaseKeys(child, `${pointer}.${key}`);
    }
};

const getNestedValue = (root: unknown, path: string[]): unknown => {
    let current: unknown = root;
    for (const segment of path) {
        if (!isRecord(current)) {
            return undefined;
        }
        current = current[segment];
    }
    return current;
};

const validateSettingValue = (
    kind: SettingsValueKind,
    value: unknown,
    keyPath: string
): SettingsScalar => {
    switch (kind) {
        case 'boolean':
            if (typeof value !== 'boolean') {
                throw new Error(`${keyPath} must be a boolean.`);
            }
            return value;
        case 'integer':
            if (
                typeof value !== 'number' ||
                Number.isNaN(value) ||
                !Number.isInteger(value)
            ) {
                throw new Error(`${keyPath} must be an integer.`);
            }
            return value;
        case 'number':
            if (typeof value !== 'number' || Number.isNaN(value)) {
                throw new Error(`${keyPath} must be a number.`);
            }
            return value;
        case 'csv':
            if (Array.isArray(value)) {
                if (!value.every((entry) => typeof entry === 'string')) {
                    throw new Error(
                        `${keyPath} array entries must be strings.`
                    );
                }
                return value;
            }
            if (typeof value !== 'string') {
                throw new Error(
                    `${keyPath} must be a comma-separated string or string array.`
                );
            }
            return value;
        case 'json':
            if (!isRecord(value)) {
                throw new Error(`${keyPath} must be an object.`);
            }
            return JSON.stringify(value);
        default:
            if (typeof value !== 'string') {
                throw new Error(`${keyPath} must be a string.`);
            }
            return value;
    }
};

const serializeSettingValue = (value: SettingsScalar): string =>
    Array.isArray(value) ? value.join(',') : String(value);

type SourceNode = {
    children: Map<string, SourceNode>;
    envKey?: string;
    source?: 'secret_env' | 'settings_yaml' | 'bootstrap_env';
    kind?: SettingsValueKind;
};

const createSourceTree = (): SourceNode => {
    const root: SourceNode = { children: new Map() };

    for (const entry of envPathSourceEntries) {
        let cursor = root;
        for (const segment of entry.path) {
            const next = cursor.children.get(segment) ?? {
                children: new Map(),
            };
            cursor.children.set(segment, next);
            cursor = next;
        }
        cursor.envKey = entry.envKey;
        cursor.source = entry.source;
        cursor.kind = entry.kind;
    }

    return root;
};

const SOURCE_TREE = createSourceTree();

const validateSupportedSettingsKeys = (
    root: Record<string, unknown>,
    pointer = 'root',
    node: SourceNode = SOURCE_TREE
): void => {
    for (const [key, value] of Object.entries(root)) {
        if (
            pointer === 'root' &&
            (key === 'version' || key === 'discord-bots')
        ) {
            continue;
        }

        const path = pointer === 'root' ? key : `${pointer}.${key}`;
        const next = node.children.get(key);
        if (!next) {
            throw new Error(
                `Invalid server settings YAML: ${path} is not a supported key.`
            );
        }

        if (next.source === 'secret_env') {
            throw new Error(
                `Invalid server settings YAML: ${path} maps to secret env key ${next.envKey} and is not YAML-configurable.`
            );
        }

        if (next.source === 'bootstrap_env') {
            throw new Error(
                `Invalid server settings YAML: ${path} maps to bootstrap env key ${next.envKey} and is not YAML-configurable.`
            );
        }

        if (next.children.size > 0) {
            if (!isRecord(value)) {
                throw new Error(
                    `Invalid server settings YAML: ${path} must be an object.`
                );
            }
            validateSupportedSettingsKeys(value, path, next);
            continue;
        }

        if (isRecord(value) && next.kind !== 'json') {
            throw new Error(
                `Invalid server settings YAML: ${path} must be a scalar or array value.`
            );
        }
    }
};

const normalizeDiscordBots = (value: unknown, settingsPath: string) => {
    if (value === undefined) {
        return [] as CanonicalDiscordBot[];
    }
    if (!Array.isArray(value)) {
        throw new Error(
            `Invalid server settings YAML at ${settingsPath}: discord-bots must be an array when provided.`
        );
    }

    return value.map((entry, index): CanonicalDiscordBot => {
        if (!isRecord(entry)) {
            throw new Error(
                `Invalid server settings YAML at ${settingsPath}: discord-bots[${index}] must be an object.`
            );
        }
        const allowedBotKeys = new Set([
            'id',
            'enabled',
            'required',
            'credentials',
            'profile',
        ]);
        for (const key of Object.keys(entry)) {
            if (!allowedBotKeys.has(key)) {
                throw new Error(
                    `Invalid server settings YAML at ${settingsPath}: discord-bots[${index}] contains unsupported key "${key}".`
                );
            }
        }

        const credentialsSource = entry['credentials'];
        const profileSource = entry['profile'];
        if (!isRecord(credentialsSource)) {
            throw new Error(
                `Invalid server settings YAML at ${settingsPath}: discord-bots[${index}].credentials must be an object.`
            );
        }
        const allowedCredentialKeys = new Set([
            'discord-token-env',
            'discord-client-id-env',
            'discord-guild-ids-env',
            'discord-user-id-env',
            'incident-secret-env',
        ]);
        for (const key of Object.keys(credentialsSource)) {
            if (!allowedCredentialKeys.has(key)) {
                throw new Error(
                    `Invalid server settings YAML at ${settingsPath}: discord-bots[${index}].credentials contains unsupported key "${key}".`
                );
            }
        }
        if (!isRecord(profileSource)) {
            throw new Error(
                `Invalid server settings YAML at ${settingsPath}: discord-bots[${index}].profile must be an object.`
            );
        }
        const allowedProfileKeys = new Set([
            'id',
            'display-name',
            'overlay-path',
            'mention-aliases',
        ]);
        for (const key of Object.keys(profileSource)) {
            if (!allowedProfileKeys.has(key)) {
                throw new Error(
                    `Invalid server settings YAML at ${settingsPath}: discord-bots[${index}].profile contains unsupported key "${key}".`
                );
            }
        }
        const mentionAliases = profileSource['mention-aliases'];
        if (
            mentionAliases !== undefined &&
            (!Array.isArray(mentionAliases) ||
                !mentionAliases.every((entry) => typeof entry === 'string'))
        ) {
            throw new Error(
                `Invalid server settings YAML at ${settingsPath}: discord-bots[${index}].profile.mention-aliases must be an array of strings.`
            );
        }

        return {
            id: typeof entry.id === 'string' ? entry.id : undefined,
            enabled:
                typeof entry.enabled === 'boolean' ? entry.enabled : undefined,
            required:
                typeof entry.required === 'boolean'
                    ? entry.required
                    : undefined,
            credentials: {
                discordTokenEnv:
                    typeof credentialsSource['discord-token-env'] === 'string'
                        ? credentialsSource['discord-token-env']
                        : undefined,
                discordClientIdEnv:
                    typeof credentialsSource['discord-client-id-env'] ===
                    'string'
                        ? credentialsSource['discord-client-id-env']
                        : undefined,
                discordGuildIdsEnv:
                    typeof credentialsSource['discord-guild-ids-env'] ===
                    'string'
                        ? credentialsSource['discord-guild-ids-env']
                        : undefined,
                discordUserIdEnv:
                    typeof credentialsSource['discord-user-id-env'] === 'string'
                        ? credentialsSource['discord-user-id-env']
                        : undefined,
                incidentSecretEnv:
                    typeof credentialsSource['incident-secret-env'] === 'string'
                        ? credentialsSource['incident-secret-env']
                        : undefined,
            },
            profile: {
                id:
                    typeof profileSource['id'] === 'string'
                        ? profileSource['id']
                        : undefined,
                displayName:
                    typeof profileSource['display-name'] === 'string'
                        ? profileSource['display-name']
                        : undefined,
                overlayPath:
                    typeof profileSource['overlay-path'] === 'string'
                        ? profileSource['overlay-path']
                        : undefined,
                mentionAliases:
                    Array.isArray(mentionAliases) && mentionAliases.length > 0
                        ? (mentionAliases as string[])
                        : undefined,
            },
        };
    });
};

/**
 * `loadServerSettings` reads the canonical `footnote.yaml` settings plane and
 * converts YAML-backed non-secret keys into an env-like map for downstream
 * config builders.
 *
 * Source boundary:
 * - `env` is trusted only for bootstrap path selection (`FOOTNOTE_SETTINGS_PATH`)
 * - YAML is trusted for non-secret runtime settings only
 * - secret/bootstrap settings inside YAML are rejected as invalid
 *
 * Behavior:
 * - Missing YAML file (`ENOENT`): fail-open, calls `warn`, returns defaults-only shape
 * - Present but invalid YAML/schema: fail-closed by throwing actionable errors
 *
 * Side effects:
 * - Reads a file from disk
 * - Emits warnings through `warn` for missing optional settings file
 *
 * @param env Process environment used only for bootstrap path resolution.
 * @param warn Warning sink for fail-open missing-file notices.
 * @returns `{ settingsPath, yamlSettings, yamlEnv }` where `yamlEnv` contains
 * env-key/value projections for YAML-configurable non-secret settings.
 */
export const loadServerSettings = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): {
    settingsPath: string;
    yamlSettings: FootnoteSettings | null;
    yamlEnv: NodeJS.ProcessEnv;
} => {
    const settingsPath = normalizePath(env.FOOTNOTE_SETTINGS_PATH);
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
    if (!isRecord(parsed)) {
        throw new Error(
            `Invalid server settings YAML at ${settingsPath}: root must be an object.`
        );
    }

    if ('settings' in parsed) {
        if (
            isRecord(parsed.settings) &&
            isRecord(parsed.settings['localNodes']) &&
            parsed.settings['localNodes']['configPath'] !== undefined
        ) {
            throw new Error(
                `Invalid server settings YAML at ${settingsPath}: settings.localNodes.configPath is removed. Configure bots under top-level discord-bots.`
            );
        }
        throw new Error(
            `Invalid server settings YAML at ${settingsPath}: legacy settings.* shape is removed. Use top-level kebab-case keys in footnote.yaml.`
        );
    }

    validateKebabCaseKeys(parsed);
    validateSupportedSettingsKeys(parsed);

    const version = parsed.version;
    if (version !== 1) {
        throw new Error(
            `Invalid server settings YAML at ${settingsPath}: version must be 1.`
        );
    }

    const settingsEnv: SettingsMap = {};
    const yamlEnv: NodeJS.ProcessEnv = {};
    for (const specEntry of settingsSpecEntries) {
        const rawValue = getNestedValue(parsed, specEntry.path);
        if (rawValue === undefined) {
            continue;
        }
        const keyPath = specEntry.path.join('.');
        const normalized = validateSettingValue(
            specEntry.kind,
            rawValue,
            keyPath
        );
        settingsEnv[keyPath] = normalized;
        yamlEnv[specEntry.envKey] = serializeSettingValue(normalized);
    }

    const discordBots = normalizeDiscordBots(
        parsed['discord-bots'],
        settingsPath
    );
    const yamlSettings: FootnoteSettings = {
        version: 1,
        'discord-bots': discordBots,
        settingsEnv,
    };

    return { settingsPath, yamlSettings, yamlEnv };
};

/**
 * `buildEffectiveConfigEnv` assembles the runtime env snapshot used by config
 * section builders after source-boundary enforcement.
 *
 * Source boundary:
 * - includes process env values for `secret_env` and `bootstrap_env` keys only
 * - applies YAML-projected values for `settings_yaml` keys only
 *
 * @param processEnv Raw process env snapshot.
 * @param yamlEnv YAML-projected non-secret settings keyed by env variable name.
 * @returns Effective env snapshot for downstream config section parsing.
 */
export const buildEffectiveConfigEnv = (
    processEnv: NodeJS.ProcessEnv,
    yamlEnv: NodeJS.ProcessEnv
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

    effectiveEnv.FOOTNOTE_SETTINGS_PATH =
        processEnv.FOOTNOTE_SETTINGS_PATH ??
        envDefaultValues.FOOTNOTE_SETTINGS_PATH;

    return effectiveEnv;
};
