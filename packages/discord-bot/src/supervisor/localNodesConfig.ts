/**
 * @description: Validates canonical Discord bot definitions and resolves credential
 * env references into runtime-safe launch settings.
 * @footnote-scope: core
 * @footnote-module: LocalNodesConfig
 * @footnote-risk: high - Invalid parsing or credential resolution can break node startup policy.
 * @footnote-ethics: medium - Node identity and secret-reference handling impact governance and operator trust.
 */

import { isRecord } from './valueGuards.js';

type CredentialReferenceKey =
    | 'discordTokenEnv'
    | 'discordClientIdEnv'
    | 'discordGuildIdsEnv'
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

/**
 * Parses and normalizes raw Discord bot node definitions.
 *
 * @param rawNodes Unknown parsed input expected to be an array of node
 * objects with `id`, optional `enabled`/`required`, `credentials`, and
 * `profile`.
 * @returns Normalized node definitions with defaults applied.
 * @throws When `rawNodes` is not an array, a node is malformed, `id` is
 * missing, or duplicate ids are present.
 *
 * Validation/normalization details:
 * - `id` is required
 * - duplicate ids are rejected
 * - `enabled` defaults to `true`
 * - `required` defaults to `false`
 */
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

    const guildIdsReference = parsedNode.credentials.discordGuildIdsEnv;
    if (!guildIdsReference) {
        return {
            kind: 'disabled',
            node: {
                id: parsedNode.id,
                required: parsedNode.required,
                reason: 'missing_credential_reference:discordGuildIdsEnv',
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

    const discordGuildIds = resolveEnvValue(
        env,
        parsedNode.credentials.discordGuildIdsEnv
    );
    if (!discordGuildIds) {
        return {
            kind: 'disabled',
            node: {
                id: parsedNode.id,
                required: parsedNode.required,
                reason: `missing_credential_env_value:${parsedNode.credentials.discordGuildIdsEnv}`,
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

/**
 * Resolves parsed node definitions against env-backed credential references.
 *
 * @param parsedNodes Normalized node definitions from
 * `parseLocalNodeDefinitions`.
 * @param env Environment variable snapshot used to resolve credential
 * references.
 * @returns Partitioned runtime result with launchable `activeNodes` and
 * non-launchable optional `disabledNodes`.
 * @throws When a required node cannot be launched due to missing references or
 * missing env credential values.
 *
 * Semantics:
 * - disabled/optional-unlaunchable nodes are returned in `disabledNodes`
 * - launchable nodes are returned in `activeNodes`
 * - required nodes that are unlaunchable cause an error
 */
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
                `Required discord bot "${resolved.node.id}" is not launchable (${resolved.node.reason}).`
            );
        }

        disabledNodes.push(resolved.node);
    }

    return { activeNodes, disabledNodes };
};
