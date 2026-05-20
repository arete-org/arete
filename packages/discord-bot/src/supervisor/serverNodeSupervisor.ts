/**
 * @description: Runs backend as the authoritative server process and supervises
 * local Discord node child processes with fail-open availability behavior.
 * @footnote-scope: core
 * @footnote-module: ServerNodeSupervisor
 * @footnote-risk: high - Process lifecycle errors here can terminate production runtime unexpectedly.
 * @footnote-ethics: medium - Startup/disable semantics control which personas are active and visible to users.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { logger } from '../utils/logger.js';
import { isRecord } from './valueGuards.js';
import {
    parseLocalNodeDefinitions,
    resolveLocalNodeDefinitions,
    type LocalNodeDefinition,
    type LocalNodeRuntimeConfig,
} from './localNodesConfig.js';
import {
    LOCAL_NODE_FAILURE_THRESHOLD,
    LOCAL_NODE_FAILURE_WINDOW_MS,
    LocalNodeRestartPolicy,
} from './restartPolicy.js';

const DISCORD_BOT_WORKDIR = '/app/packages/discord-bot';
const BACKEND_WORKDIR = '/app/packages/backend';
const BACKEND_ENTRYPOINT = '/usr/local/bin/backend-entrypoint.sh';
const DEFAULT_BACKEND_PORT = '3000';
const NODE_RESTART_DELAY_MS = 1000;
const PROCESS_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_SERVER_SETTINGS_PATH = '/data/config/footnote.yaml';

type YamlModule = { load(input: string): unknown };
const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as YamlModule;

type NodeProcessState = {
    config: LocalNodeRuntimeConfig;
    child: ChildProcess | null;
    unhealthy: boolean;
    restartPolicy: LocalNodeRestartPolicy;
    restartTimer: NodeJS.Timeout | null;
};

const normalizePort = (value: string | undefined): string => {
    if (!value) {
        return DEFAULT_BACKEND_PORT;
    }
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
        return trimmed;
    }
    return DEFAULT_BACKEND_PORT;
};

const resolveBackendBaseUrl = (env: NodeJS.ProcessEnv): string => {
    const configured = env.BACKEND_BASE_URL?.trim();
    if (configured && configured.length > 0) {
        return configured.replace(/\/+$/, '');
    }
    return `http://localhost:${normalizePort(env.PORT)}`;
};

/**
 * Loads canonical Discord bot definitions from `footnote.yaml`.
 *
 * Contract:
 * - Returns `null` when the settings file is missing (`ENOENT`) so callers can
 *   treat startup as fail-open with "no configured bots".
 * - Returns `[]` when the settings file exists but `discord-bots` is unset or
 *   explicitly empty.
 * - Throws when YAML is malformed or validation fails.
 *
 * `start()` treats `null` and `[]` differently (`missing` vs `configured`), so
 * callers must preserve that distinction.
 */
const loadCanonicalLocalNodeDefinitions = (
    env: NodeJS.ProcessEnv
): LocalNodeDefinition[] | null => {
    if (
        typeof env.LOCAL_DISCORD_NODES_CONFIG_PATH === 'string' &&
        env.LOCAL_DISCORD_NODES_CONFIG_PATH.trim().length > 0
    ) {
        logger.warn(
            'LOCAL_DISCORD_NODES_CONFIG_PATH is unsupported in server runtime. Ignoring env value and loading discord-bots from footnote.yaml only.'
        );
    }

    const settingsPath =
        env.FOOTNOTE_SETTINGS_PATH?.trim() || DEFAULT_SERVER_SETTINGS_PATH;
    try {
        const raw = fs.readFileSync(settingsPath, 'utf8');
        const parsed = yaml.load(raw);
        if (!isRecord(parsed)) {
            return [];
        }
        if ('settings' in parsed) {
            if (!isRecord(parsed.settings)) {
                throw new Error(
                    `Invalid server settings YAML at ${settingsPath}: settings must be an object when present.`
                );
            }
            throw new Error(
                'legacy settings.* YAML shape is removed. Use top-level discord-bots in footnote.yaml.'
            );
        }

        const discordBots = parsed['discord-bots'];
        if (discordBots === undefined) {
            return [];
        }
        if (!Array.isArray(discordBots)) {
            throw new Error('discord-bots must be an array when provided.');
        }
        return parseLocalNodeDefinitions(
            discordBots.map((entry) => {
                if (!isRecord(entry)) {
                    return entry;
                }
                const credentials = isRecord(entry.credentials)
                    ? entry.credentials
                    : {};
                const profile = isRecord(entry.profile) ? entry.profile : {};
                return {
                    id: entry.id,
                    enabled: entry.enabled,
                    required: entry.required,
                    credentials: {
                        discordTokenEnv: credentials['discord-token-env'],
                        discordClientIdEnv:
                            credentials['discord-client-id-env'],
                        discordGuildIdsEnv:
                            credentials['discord-guild-ids-env'],
                        discordUserIdEnv: credentials['discord-user-id-env'],
                        incidentSecretEnv: credentials['incident-secret-env'],
                    },
                    profile: {
                        id: profile.id,
                        displayName: profile['display-name'],
                        overlayPath: profile['overlay-path'],
                        mentionAliases: profile['mention-aliases'],
                    },
                };
            })
        );
    } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === 'ENOENT') {
            logger.warn(
                `Server settings YAML not found at ${settingsPath}; starting with no configured discord bots.`
            );
            return null;
        }
        throw new Error(
            `Invalid server settings YAML at ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
        );
    }
};

const stopChildProcess = async (
    child: ChildProcess | null,
    label: string
): Promise<void> => {
    if (!child || child.killed || child.exitCode !== null) {
        return;
    }

    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
            if (child.exitCode === null) {
                logger.warn(
                    'Child process did not exit after SIGTERM; forcing SIGKILL.',
                    {
                        process: label,
                        pid: child.pid,
                    }
                );
                child.kill('SIGKILL');
            }
            resolve();
        }, PROCESS_STOP_TIMEOUT_MS);

        child.once('exit', () => {
            clearTimeout(timeout);
            resolve();
        });
    });
};

const buildNodeEnvironment = (
    parentEnv: NodeJS.ProcessEnv,
    nodeConfig: LocalNodeRuntimeConfig,
    backendBaseUrl: string
): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
        ...parentEnv,
        BACKEND_BASE_URL: backendBaseUrl,
        DISCORD_TOKEN: nodeConfig.credentials.discordToken,
        DISCORD_CLIENT_ID: nodeConfig.credentials.discordClientId,
        DISCORD_GUILD_IDS: nodeConfig.credentials.discordGuildIds,
        DISCORD_USER_ID: nodeConfig.credentials.discordUserId,
        INCIDENT_PSEUDONYMIZATION_SECRET: nodeConfig.credentials.incidentSecret,
        BOT_PROFILE_ID: nodeConfig.profile.id,
        BOT_PROFILE_DISPLAY_NAME: nodeConfig.profile.displayName,
        LOCAL_DISCORD_NODE_ID: nodeConfig.id,
    };

    if (nodeConfig.profile.overlayPath) {
        env.BOT_PROFILE_PROMPT_OVERLAY_PATH = nodeConfig.profile.overlayPath;
    } else {
        delete env.BOT_PROFILE_PROMPT_OVERLAY_PATH;
    }

    if (nodeConfig.profile.mentionAliases.length > 0) {
        env.BOT_PROFILE_MENTION_ALIASES =
            nodeConfig.profile.mentionAliases.join(',');
    } else {
        delete env.BOT_PROFILE_MENTION_ALIASES;
    }

    return env;
};

class ServerNodeSupervisor {
    private shuttingDown = false;
    private backendProcess: ChildProcess | null = null;
    private readonly nodeStates = new Map<string, NodeProcessState>();

    constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

    async start(): Promise<void> {
        const localNodeDefinitions = loadCanonicalLocalNodeDefinitions(
            this.env
        );
        const resolvedNodes =
            localNodeDefinitions === null
                ? { activeNodes: [], disabledNodes: [] }
                : resolveLocalNodeDefinitions(localNodeDefinitions, this.env);
        const backendBaseUrl = resolveBackendBaseUrl(this.env);

        logger.info('discord_bots_config_status', {
            status: localNodeDefinitions === null ? 'missing' : 'configured',
            configPath:
                this.env.FOOTNOTE_SETTINGS_PATH?.trim() ||
                DEFAULT_SERVER_SETTINGS_PATH,
            activeNodeCount: resolvedNodes.activeNodes.length,
            disabledNodeCount: resolvedNodes.disabledNodes.length,
        });

        for (const disabledNode of resolvedNodes.disabledNodes) {
            logger.info('discord_bot_disabled', {
                nodeId: disabledNode.id,
                reason: disabledNode.reason,
                required: disabledNode.required,
            });
        }

        if (resolvedNodes.activeNodes.length === 0) {
            logger.info('no_discord_bots_configured', {
                reason:
                    localNodeDefinitions === null
                        ? 'config_missing'
                        : 'no_launchable_nodes',
                configPath:
                    this.env.FOOTNOTE_SETTINGS_PATH?.trim() ||
                    DEFAULT_SERVER_SETTINGS_PATH,
            });
        }

        this.installSignalHandlers();
        this.startBackendProcess();

        for (const nodeConfig of resolvedNodes.activeNodes) {
            const state: NodeProcessState = {
                config: nodeConfig,
                child: null,
                unhealthy: false,
                restartPolicy: new LocalNodeRestartPolicy(),
                restartTimer: null,
            };
            this.nodeStates.set(nodeConfig.id, state);
            this.startNodeProcess(state, backendBaseUrl);
        }
    }

    private startBackendProcess(): void {
        const child = spawn(BACKEND_ENTRYPOINT, [], {
            cwd: BACKEND_WORKDIR,
            env: this.env,
            stdio: 'inherit',
        });
        this.backendProcess = child;

        child.once('exit', (code, signal) => {
            if (this.shuttingDown) {
                return;
            }
            logger.error('backend_process_exited', {
                code,
                signal,
            });
            void this.shutdownForBackendExit();
        });
    }

    private async shutdownForBackendExit(): Promise<void> {
        this.shuttingDown = true;
        await this.stopAllNodeProcesses();
        process.exit(1);
    }

    private startNodeProcess(
        state: NodeProcessState,
        backendBaseUrl: string
    ): void {
        if (this.shuttingDown || state.unhealthy) {
            return;
        }

        const nodeEnv = buildNodeEnvironment(
            this.env,
            state.config,
            backendBaseUrl
        );
        const child = spawn('node', ['dist/index.js'], {
            cwd: DISCORD_BOT_WORKDIR,
            env: nodeEnv,
            stdio: 'inherit',
        });
        state.child = child;

        logger.info('discord_bot_started', {
            nodeId: state.config.id,
            pid: child.pid,
            required: state.config.required,
            profileId: state.config.profile.id,
        });

        child.once('exit', (code, signal) => {
            state.child = null;
            if (this.shuttingDown) {
                return;
            }

            const failureDecision = state.restartPolicy.recordFailure();
            logger.warn('discord_bot_exited', {
                nodeId: state.config.id,
                code,
                signal,
                failureCount: failureDecision.failureCount,
            });

            if (failureDecision.unhealthy) {
                state.unhealthy = true;
                logger.error('discord_bot_unhealthy', {
                    nodeId: state.config.id,
                    failureCount: failureDecision.failureCount,
                    threshold: LOCAL_NODE_FAILURE_THRESHOLD,
                    windowMs: LOCAL_NODE_FAILURE_WINDOW_MS,
                });
                return;
            }

            state.restartTimer = setTimeout(() => {
                state.restartTimer = null;
                this.startNodeProcess(state, backendBaseUrl);
            }, NODE_RESTART_DELAY_MS);
        });
    }

    private installSignalHandlers(): void {
        const handleSignal = (signal: NodeJS.Signals) => {
            if (this.shuttingDown) {
                return;
            }
            this.shuttingDown = true;
            logger.info('server_shutdown_signal', { signal });
            void this.shutdownAll(signal);
        };

        process.on('SIGTERM', () => {
            handleSignal('SIGTERM');
        });
        process.on('SIGINT', () => {
            handleSignal('SIGINT');
        });
    }

    private async stopAllNodeProcesses(): Promise<void> {
        const stopPromises: Promise<void>[] = [];
        for (const state of this.nodeStates.values()) {
            if (state.restartTimer) {
                clearTimeout(state.restartTimer);
                state.restartTimer = null;
            }
            stopPromises.push(
                stopChildProcess(state.child, `local-node:${state.config.id}`)
            );
        }
        await Promise.all(stopPromises);
    }

    private async shutdownAll(signal: NodeJS.Signals): Promise<void> {
        await this.stopAllNodeProcesses();
        await stopChildProcess(this.backendProcess, 'backend');
        process.exit(signal === 'SIGINT' ? 130 : 143);
    }
}

const supervisor = new ServerNodeSupervisor();
supervisor.start().catch((error: unknown) => {
    logger.error('server_supervisor_start_failed', {
        error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
});
