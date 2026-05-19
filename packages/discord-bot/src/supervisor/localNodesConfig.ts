/**
 * @description: Loads and validates server-local Discord node YAML config, then resolves
 * credential env references into runtime-safe node launch settings.
 * @footnote-scope: core
 * @footnote-module: LocalNodesConfig
 * @footnote-risk: high - Invalid parsing or credential resolution can break node startup policy.
 * @footnote-ethics: medium - Node identity and secret-reference handling impact governance and operator trust.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';

type YamlModule = {
    load(input: string): unknown;
};

const require = createRequire(import.meta.url);
const loadYamlModule = (): YamlModule => {
    try {
        return require('js-yaml') as YamlModule;
    } catch (error) {
        throw new Error(
            `Missing dependency "js-yaml" for local node config parsing. Install workspace dependencies (pnpm install).`,
            { cause: error }
        );
    }
};
const yamlModule = loadYamlModule();

export const DEFAULT_LOCAL_DISCORD_NODES_CONFIG_PATH =
    '/data/config/local-discord-nodes.yaml';

const SUPPORTED_CONFIG_VERSION = 1;

type CredentialReferenceKey =
    | 'discordTokenEnv'
    | 'discordClientIdEnv'
    | 'discordGuildIdsEnv'
    | 'discordGuildIdEnv'
    | 'discordUserIdEnv'
    | 'incidentSecretEnv';

type RequiredCredentialReferenceKey =
    | 'discordTokenEnv'
    | 'discordClientIdEnv'
    | 'discordUserIdEnv'
    | 'incidentSecretEnv';

type LocalNodeCredentialReferences = {
    discordTokenEnv?: string;
    discordClientIdEnv?: string;
    discordGuildIdsEnv?: string;
    discordGuildIdEnv?: string;
    discordUserIdEnv?: string;
    incidentSecretEnv?: string;
};

type LocalNodeProfileConfig = {
    id: string;
    displayName: string;
    overlayPath?: string;
    mentionAliases?: string[];
};

type ParsedNodeConfig = {
    id: string;
    enabled: boolean;
    required: boolean;
    credentials: LocalNodeCredentialReferences;
    profile: LocalNodeProfileConfig;
};

export type LocalNodeDefinition = ParsedNodeConfig;

export type LocalNodeResolvedCredentials = {
    discordToken: string;
    discordClientId: string;
    discordGuildIds: string;
    discordUserId: string;
    incidentSecret: string;
};

export type LocalNodeRuntimeConfig = {
    id: string;
    required: boolean;
    credentials: LocalNodeResolvedCredentials;
    profile: {
        id: string;
        displayName: string;
        overlayPath?: string;
        mentionAliases: string[];
    };
};

export type LocalNodeDisabledConfig = {
    id: string;
    required: boolean;
    reason: string;
};

export type LocalNodeConfigLoadResult = {
    status: 'configured' | 'missing';
    configPath: string;
    activeNodes: LocalNodeRuntimeConfig[];
    disabledNodes: LocalNodeDisabledConfig[];
};

type LoadLocalNodeConfigOptions = {
    env?: NodeJS.ProcessEnv;
    configPath?: string;
    readFile?: (path: string) => string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const normalizeOptionalString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeBoolean = (
    value: unknown,
    fallback: boolean,
    label: string
): boolean => {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== 'boolean') {
        throw new Error(`${label} must be a boolean.`);
    }
    return value;
};

const parseMentionAliases = (
    value: unknown,
    nodeId: string
): string[] | undefined => {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        throw new Error(
            `nodes["${nodeId}"].profile.mentionAliases must be an array of strings.`
        );
    }

    const aliases = value
        .map((entry) => {
            if (typeof entry !== 'string') {
                throw new Error(
                    `nodes["${nodeId}"].profile.mentionAliases entries must be strings.`
                );
            }
            return entry.trim();
        })
        .filter((entry) => entry.length > 0);

    return [...new Set(aliases)];
};

const parseProfile = (
    value: unknown,
    nodeId: string
): LocalNodeProfileConfig => {
    if (!isRecord(value)) {
        throw new Error(`nodes["${nodeId}"].profile must be an object.`);
    }

    const profileId = normalizeOptionalString(value.id);
    if (!profileId) {
        throw new Error(`nodes["${nodeId}"].profile.id is required.`);
    }

    const displayName = normalizeOptionalString(value.displayName);
    if (!displayName) {
        throw new Error(`nodes["${nodeId}"].profile.displayName is required.`);
    }

    const overlayPath = normalizeOptionalString(value.overlayPath);
    const mentionAliases = parseMentionAliases(value.mentionAliases, nodeId);

    return {
        id: profileId,
        displayName,
        overlayPath,
        mentionAliases,
    };
};

const parseCredentialReferences = (
    value: unknown,
    nodeId: string
): LocalNodeCredentialReferences => {
    if (!isRecord(value)) {
        throw new Error(`nodes["${nodeId}"].credentials must be an object.`);
    }

    const credentialReferences: LocalNodeCredentialReferences = {
        discordTokenEnv: normalizeOptionalString(value.discordTokenEnv),
        discordClientIdEnv: normalizeOptionalString(value.discordClientIdEnv),
        discordGuildIdsEnv: normalizeOptionalString(value.discordGuildIdsEnv),
        discordGuildIdEnv: normalizeOptionalString(value.discordGuildIdEnv),
        discordUserIdEnv: normalizeOptionalString(value.discordUserIdEnv),
        incidentSecretEnv: normalizeOptionalString(value.incidentSecretEnv),
    };

    for (const key of Object.keys(value)) {
        const knownKey = key as CredentialReferenceKey;
        if (!(knownKey in credentialReferences)) {
            throw new Error(
                `nodes["${nodeId}"].credentials contains unsupported key "${key}".`
            );
        }
        if (
            value[key] !== undefined &&
            credentialReferences[knownKey] === undefined
        ) {
            throw new Error(
                `nodes["${nodeId}"].credentials.${key} must be a non-empty string when provided.`
            );
        }
    }

    return credentialReferences;
};

export const parseLocalNodeDefinitions = (
    rawNodes: unknown
): ParsedNodeConfig[] => {
    if (!Array.isArray(rawNodes)) {
        throw new Error('nodes must be an array.');
    }

    const parsedNodes: ParsedNodeConfig[] = [];
    const seenIds = new Set<string>();

    for (const rawNode of rawNodes) {
        if (!isRecord(rawNode)) {
            throw new Error('Each node entry must be an object.');
        }

        const nodeId = normalizeOptionalString(rawNode.id);
        if (!nodeId) {
            throw new Error('nodes[].id is required.');
        }

        if (seenIds.has(nodeId)) {
            throw new Error(`Duplicate node id "${nodeId}" is not allowed.`);
        }
        seenIds.add(nodeId);

        const enabled = normalizeBoolean(
            rawNode.enabled,
            true,
            `nodes["${nodeId}"].enabled`
        );
        const required = normalizeBoolean(
            rawNode.required,
            false,
            `nodes["${nodeId}"].required`
        );
        const credentials = parseCredentialReferences(
            rawNode.credentials,
            nodeId
        );
        const profile = parseProfile(rawNode.profile, nodeId);

        parsedNodes.push({
            id: nodeId,
            enabled,
            required,
            credentials,
            profile,
        });
    }

    return parsedNodes;
};

const parseRawConfig = (contents: string): ParsedNodeConfig[] => {
    const rawParsed = yamlModule.load(contents);
    if (!isRecord(rawParsed)) {
        throw new Error('Local nodes config must be a YAML object.');
    }

    const version = rawParsed.version;
    if (version !== SUPPORTED_CONFIG_VERSION) {
        throw new Error(
            `Unsupported local nodes config version "${String(version)}". Expected ${SUPPORTED_CONFIG_VERSION}.`
        );
    }

    return parseLocalNodeDefinitions(rawParsed.nodes);
};

const resolveEnvValue = (
    env: NodeJS.ProcessEnv,
    envKey: string | undefined
): string | undefined => {
    if (!envKey) {
        return undefined;
    }
    const value = env[envKey];
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const resolveRequiredCredentialReference = (
    references: LocalNodeCredentialReferences,
    key: RequiredCredentialReferenceKey
): string | undefined => references[key];

const resolveRuntimeNode = (
    parsedNode: ParsedNodeConfig,
    env: NodeJS.ProcessEnv
):
    | { kind: 'active'; node: LocalNodeRuntimeConfig }
    | { kind: 'disabled'; node: LocalNodeDisabledConfig } => {
    if (!parsedNode.enabled) {
        return {
            kind: 'disabled',
            node: {
                id: parsedNode.id,
                required: parsedNode.required,
                reason: 'node_disabled_in_config',
            },
        };
    }

    const requiredReferences: RequiredCredentialReferenceKey[] = [
        'discordTokenEnv',
        'discordClientIdEnv',
        'discordUserIdEnv',
        'incidentSecretEnv',
    ];

    for (const referenceKey of requiredReferences) {
        const envKey = resolveRequiredCredentialReference(
            parsedNode.credentials,
            referenceKey
        );
        if (!envKey) {
            return {
                kind: 'disabled',
                node: {
                    id: parsedNode.id,
                    required: parsedNode.required,
                    reason: `missing_credential_reference:${referenceKey}`,
                },
            };
        }
    }

    const guildIdsReference =
        parsedNode.credentials.discordGuildIdsEnv ??
        parsedNode.credentials.discordGuildIdEnv;
    if (!guildIdsReference) {
        return {
            kind: 'disabled',
            node: {
                id: parsedNode.id,
                required: parsedNode.required,
                reason: 'missing_credential_reference:discordGuildIdsEnv|discordGuildIdEnv',
            },
        };
    }

    const discordToken = resolveEnvValue(
        env,
        parsedNode.credentials.discordTokenEnv
    );
    if (!discordToken) {
        return {
            kind: 'disabled',
            node: {
                id: parsedNode.id,
                required: parsedNode.required,
                reason: `missing_credential_env_value:${parsedNode.credentials.discordTokenEnv}`,
            },
        };
    }

    const discordClientId = resolveEnvValue(
        env,
        parsedNode.credentials.discordClientIdEnv
    );
    if (!discordClientId) {
        return {
            kind: 'disabled',
            node: {
                id: parsedNode.id,
                required: parsedNode.required,
                reason: `missing_credential_env_value:${parsedNode.credentials.discordClientIdEnv}`,
            },
        };
    }

    const guildIdsFromPreferred = resolveEnvValue(
        env,
        parsedNode.credentials.discordGuildIdsEnv
    );
    const guildIdsFromLegacy = resolveEnvValue(
        env,
        parsedNode.credentials.discordGuildIdEnv
    );
    const discordGuildIds = guildIdsFromPreferred ?? guildIdsFromLegacy;
    if (!discordGuildIds) {
        const attemptedKeys = [
            parsedNode.credentials.discordGuildIdsEnv,
            parsedNode.credentials.discordGuildIdEnv,
        ]
            .filter((entry): entry is string => typeof entry === 'string')
            .join('|');
        return {
            kind: 'disabled',
            node: {
                id: parsedNode.id,
                required: parsedNode.required,
                reason: `missing_credential_env_value:${attemptedKeys}`,
            },
        };
    }

    const discordUserId = resolveEnvValue(
        env,
        parsedNode.credentials.discordUserIdEnv
    );
    if (!discordUserId) {
        return {
            kind: 'disabled',
            node: {
                id: parsedNode.id,
                required: parsedNode.required,
                reason: `missing_credential_env_value:${parsedNode.credentials.discordUserIdEnv}`,
            },
        };
    }

    const incidentSecret = resolveEnvValue(
        env,
        parsedNode.credentials.incidentSecretEnv
    );
    if (!incidentSecret) {
        return {
            kind: 'disabled',
            node: {
                id: parsedNode.id,
                required: parsedNode.required,
                reason: `missing_credential_env_value:${parsedNode.credentials.incidentSecretEnv}`,
            },
        };
    }

    return {
        kind: 'active',
        node: {
            id: parsedNode.id,
            required: parsedNode.required,
            credentials: {
                discordToken,
                discordClientId,
                discordGuildIds,
                discordUserId,
                incidentSecret,
            },
            profile: {
                id: parsedNode.profile.id,
                displayName: parsedNode.profile.displayName,
                overlayPath: parsedNode.profile.overlayPath,
                mentionAliases: parsedNode.profile.mentionAliases ?? [],
            },
        },
    };
};

export const resolveLocalNodeDefinitions = (
    parsedNodes: LocalNodeDefinition[],
    env: NodeJS.ProcessEnv
): {
    activeNodes: LocalNodeRuntimeConfig[];
    disabledNodes: LocalNodeDisabledConfig[];
} => {
    const activeNodes: LocalNodeRuntimeConfig[] = [];
    const disabledNodes: LocalNodeDisabledConfig[] = [];

    for (const parsedNode of parsedNodes) {
        const resolved = resolveRuntimeNode(parsedNode, env);
        if (resolved.kind === 'active') {
            activeNodes.push(resolved.node);
            continue;
        }

        if (resolved.node.required) {
            throw new Error(
                `Required local node "${resolved.node.id}" is not launchable (${resolved.node.reason}).`
            );
        }

        disabledNodes.push(resolved.node);
    }

    return { activeNodes, disabledNodes };
};

/**
 * Loads server-local Discord node YAML config and resolves launchable node runtime settings.
 *
 * Inputs:
 * - `LoadLocalNodeConfigOptions` (`env`, optional `configPath`, optional `readFile` override)
 *
 * Returns:
 * - `LocalNodeConfigLoadResult` with `status`, `configPath`, `activeNodes`, and `disabledNodes`
 *
 * Guarantee and fail-open semantics:
 * - missing config file (`ENOENT`) returns `status: "missing"` with empty node lists
 * - optional nodes with missing refs/env values are returned in `disabledNodes`
 * - required nodes are enforced and cause loader failure when not launchable
 *
 * Throw behavior:
 * - unreadable config files (except `ENOENT`)
 * - invalid YAML/schema/version
 * - required node resolution failures
 *
 * Side effects:
 * - reads the YAML config file from disk unless `readFile` is injected
 * - no logging is performed in this loader; callers own logging decisions
 */
export const loadLocalNodeConfig = (
    options: LoadLocalNodeConfigOptions = {}
): LocalNodeConfigLoadResult => {
    const env = options.env ?? process.env;
    const configPath =
        normalizeOptionalString(options.configPath) ??
        normalizeOptionalString(env.LOCAL_DISCORD_NODES_CONFIG_PATH) ??
        DEFAULT_LOCAL_DISCORD_NODES_CONFIG_PATH;
    const readFile =
        options.readFile ??
        ((targetPath: string) => fs.readFileSync(targetPath, 'utf8'));

    let rawConfigText: string;
    try {
        rawConfigText = readFile(configPath);
    } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === 'ENOENT') {
            return {
                status: 'missing',
                configPath,
                activeNodes: [],
                disabledNodes: [],
            };
        }

        throw new Error(
            `Failed to read local nodes config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
            {
                cause: error,
            }
        );
    }

    const parsedNodes = parseRawConfig(rawConfigText);
    const { activeNodes, disabledNodes } = resolveLocalNodeDefinitions(
        parsedNodes,
        env
    );

    return {
        status: 'configured',
        configPath,
        activeNodes,
        disabledNodes,
    };
};
