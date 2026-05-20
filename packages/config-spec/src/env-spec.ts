/**
 * @description: Shared environment metadata and canonical defaults used across packages.
 * @footnote-scope: interface
 * @footnote-module: EnvSpec
 * @footnote-risk: medium - Wrong defaults or metadata can create cross-package config drift.
 * @footnote-ethics: medium - Env defaults influence safety, logging, and transparency behavior.
 */

import { defineEnv, derived, literal, noDefault } from './env-factories.js';
import {
    supportedBotInteractionActions,
    supportedEngagementIgnoreModes,
    supportedLogLevels,
    supportedNodeEnvs,
    supportedOpenAIRealtimeModels,
    supportedOpenAIRealtimeTurnDetections,
    supportedOpenAIRealtimeVadEagerness,
    supportedOpenAITtsVoices,
    supportedReasoningEfforts,
    supportedVerbosityLevels,
} from '@footnote/contracts/providers';
import type { EnvSpecEntry } from './types.js';

// This file is the single source of truth for environment metadata.
// Each env variable is declared once below, and every exported view is derived
// from that one declaration.
/**
 * Ordered environment spec entries used for docs, tooling, and runtime config
 * generation.
 */
export const envEntries = [
    defineEnv({
        key: 'OPENAI_API_KEY',
        owner: 'shared',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: true,
        kind: 'string',
        description:
            'OpenAI API key used when OpenAI-backed profiles or OpenAI-only routes are enabled.',
        defaultValue: noDefault(),
        usedBy: [
            'packages/backend/src/config.ts',
            'packages/discord-bot/src/config.ts',
        ],
    }),

    defineEnv({
        key: 'OLLAMA_BASE_URL',
        owner: 'backend',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Base URL for Ollama inference (local daemon or Ollama cloud endpoint).',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'OLLAMA_API_KEY',
        owner: 'backend',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: true,
        kind: 'string',
        description:
            'Optional Ollama API key for cloud-hosted endpoints that require auth.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'OLLAMA_LOCAL_INFERENCE_ENABLED',
        owner: 'backend',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'boolean',
        description:
            'When true, allows model profiles to target local Ollama hosts (localhost/loopback).',
        defaultValue: literal(false),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'LITESTREAM_REPLICA_URL',
        owner: 'backend',
        stage: 'runtime',
        section: 'storage',
        required: false,
        secret: true,
        kind: 'string',
        description:
            'S3-compatible replica URL used by Litestream for SQLite backup replication.',
        defaultValue: noDefault(),
        usedBy: ['deploy/litestream.yml', 'packages/backend/src/server.ts'],
    }),

    defineEnv({
        key: 'INCIDENT_PSEUDONYMIZATION_SECRET',
        owner: 'shared',
        stage: 'runtime',
        section: 'security',
        required: true,
        secret: true,
        kind: 'string',
        description: 'HMAC secret used to pseudonymize stored identifiers.',
        defaultValue: noDefault(),
        usedBy: [
            'packages/backend/src/config.ts',
            'packages/discord-bot/src/config.ts',
        ],
    }),

    defineEnv({
        key: 'INCIDENT_ALERTS_DISCORD_ENABLED',
        owner: 'backend',
        stage: 'runtime',
        section: 'alerts',
        required: false,
        secret: false,
        kind: 'boolean',
        description:
            'Enable incident/breaker alerts to a Discord channel target.',
        defaultValue: literal(false),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'INCIDENT_ALERTS_DISCORD_BOT_TOKEN',
        owner: 'backend',
        stage: 'runtime',
        section: 'alerts',
        required: false,
        secret: true,
        kind: 'string',
        description:
            'Discord bot token used to send incident alerts into the configured channel.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'INCIDENT_ALERTS_DISCORD_CHANNEL_ID',
        owner: 'backend',
        stage: 'runtime',
        section: 'alerts',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Discord channel ID used as the incident alert destination.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'INCIDENT_ALERTS_DISCORD_ROLE_ID',
        owner: 'backend',
        stage: 'runtime',
        section: 'alerts',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Optional Discord role ID to mention in incident alert messages.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'INCIDENT_ALERTS_EMAIL_ENABLED',
        owner: 'backend',
        stage: 'runtime',
        section: 'alerts',
        required: false,
        secret: false,
        kind: 'boolean',
        description:
            'Enable incident/breaker alerts to the configured admin email recipients.',
        defaultValue: literal(false),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'INCIDENT_ALERTS_EMAIL_SMTP_HOST',
        owner: 'backend',
        stage: 'runtime',
        section: 'alerts',
        required: false,
        secret: false,
        kind: 'string',
        description: 'SMTP host for admin email alert delivery.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'INCIDENT_ALERTS_EMAIL_SMTP_PORT',
        owner: 'backend',
        stage: 'runtime',
        section: 'alerts',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'SMTP port for admin email alert delivery.',
        defaultValue: literal(587),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'INCIDENT_ALERTS_EMAIL_SMTP_SECURE',
        owner: 'backend',
        stage: 'runtime',
        section: 'alerts',
        required: false,
        secret: false,
        kind: 'boolean',
        description:
            'When true, uses implicit TLS for SMTP alert delivery (typically port 465).',
        defaultValue: literal(false),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'INCIDENT_ALERTS_EMAIL_SMTP_USERNAME',
        owner: 'backend',
        stage: 'runtime',
        section: 'alerts',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Optional SMTP username for authenticated admin email alert delivery.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'INCIDENT_ALERTS_EMAIL_SMTP_PASSWORD',
        owner: 'backend',
        stage: 'runtime',
        section: 'alerts',
        required: false,
        secret: true,
        kind: 'string',
        description:
            'Optional SMTP password for authenticated admin email alert delivery.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'INCIDENT_ALERTS_EMAIL_FROM',
        owner: 'backend',
        stage: 'runtime',
        section: 'alerts',
        required: false,
        secret: false,
        kind: 'string',
        description: 'From-address used for admin email alerts.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'INCIDENT_ALERTS_EMAIL_TO',
        owner: 'backend',
        stage: 'runtime',
        section: 'alerts',
        required: false,
        secret: false,
        kind: 'csv',
        description:
            'Comma-separated admin recipient addresses for incident alert emails.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'LOG_DIR',
        owner: 'shared',
        stage: 'runtime',
        section: 'logging',
        required: false,
        secret: false,
        kind: 'string',
        description: 'Directory where rotating log files are written.',
        defaultValue: literal('logs'),
        usedBy: [
            'packages/backend/src/config.ts',
            'packages/backend/src/utils/logger.ts',
            'packages/discord-bot/src/config.ts',
            'packages/discord-bot/src/utils/logger.ts',
        ],
    }),

    defineEnv({
        key: 'LOG_LEVEL',
        owner: 'shared',
        stage: 'runtime',
        section: 'logging',
        required: false,
        secret: false,
        kind: 'enum',
        description: 'Logger verbosity level.',
        defaultValue: literal('info'),
        allowedValues: supportedLogLevels,
        usedBy: [
            'packages/backend/src/config.ts',
            'packages/backend/src/utils/logger.ts',
            'packages/discord-bot/src/config.ts',
            'packages/discord-bot/src/utils/logger.ts',
        ],
    }),

    defineEnv({
        key: 'NODE_ENV',
        owner: 'shared',
        stage: 'runtime',
        section: 'runtime',
        required: false,
        secret: false,
        kind: 'enum',
        description:
            'Node runtime mode used for production/development branching.',
        defaultValue: literal('development'),
        allowedValues: supportedNodeEnvs,
        usedBy: [
            'packages/backend/src/config.ts',
            'packages/discord-bot/src/config.ts',
        ],
    }),

    defineEnv({
        key: 'FLY_APP_NAME',
        owner: 'shared',
        stage: 'runtime',
        section: 'runtime',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Fly app name used to derive internal or public service URLs.',
        defaultValue: noDefault(),
        usedBy: [
            'packages/backend/src/config.ts',
            'packages/discord-bot/src/config.ts',
        ],
    }),

    defineEnv({
        key: 'BACKEND_BASE_URL',
        owner: 'shared',
        stage: 'runtime',
        section: 'urls',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Base URL used for bot-to-backend requests and the web dev proxy.',
        defaultValue: derived(
            'Defaults to the Fly internal backend URL on Fly, otherwise http://localhost:3000.',
            'http://localhost:3000'
        ),
        usedBy: [
            'packages/discord-bot/src/config.ts',
            'packages/web/vite.config.ts',
        ],
    }),

    defineEnv({
        key: 'FOOTNOTE_SERVER_SETTINGS_PATH',
        owner: 'shared',
        stage: 'bootstrap',
        section: 'runtime',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Optional server-local path to canonical runtime settings YAML. Defaults to /data/config/footnote.server.yaml when unset.',
        defaultValue: literal('/data/config/footnote.server.yaml'),
        usedBy: [
            'packages/backend/src/config/settings.ts',
            'packages/discord-bot/src/supervisor/serverNodeSupervisor.ts',
            'deploy/fly/deploy.sh',
            'deploy/fly/deploy.ps1',
        ],
    }),

    defineEnv({
        key: 'TRACE_API_TOKEN',
        owner: 'shared',
        stage: 'runtime',
        section: 'trace',
        required: false,
        secret: true,
        kind: 'string',
        description: 'Shared secret for trusted trace ingestion requests.',
        defaultValue: noDefault(),
        usedBy: [
            'packages/backend/src/config.ts',
            'packages/discord-bot/src/config.ts',
        ],
    }),
    defineEnv({
        key: 'TRACE_API_TOKEN_FILE',
        owner: 'shared',
        stage: 'runtime',
        section: 'trace',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Optional file path used to load the trace API token before fallback token generation.',
        defaultValue: literal('/data/secrets/trace-api-token'),
        usedBy: ['deploy/traceTokenResolver.mjs'],
    }),
    defineEnv({
        key: 'VOLTAGENT_PUBLIC_KEY',
        owner: 'backend',
        stage: 'runtime',
        section: 'trace',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'VoltOps project public key used for optional backend observability tracing.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),
    defineEnv({
        key: 'VOLTAGENT_SECRET_KEY',
        owner: 'backend',
        stage: 'runtime',
        section: 'trace',
        required: false,
        secret: true,
        kind: 'string',
        description:
            'VoltOps project secret key used for optional backend observability tracing.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),
    defineEnv({
        key: 'LANGFUSE_METADATA_MIRROR_ENABLED',
        owner: 'backend',
        stage: 'runtime',
        section: 'trace',
        required: false,
        secret: false,
        kind: 'boolean',
        description:
            'Enables metadata-only Langfuse observability mirroring from backend trace writes.',
        defaultValue: literal(false),
        usedBy: ['packages/backend/src/config.ts'],
    }),
    defineEnv({
        key: 'LANGFUSE_METADATA_MIRROR_BASE_URL',
        owner: 'backend',
        stage: 'runtime',
        section: 'trace',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Langfuse base URL used for metadata mirror export (for example https://cloud.langfuse.com).',
        defaultValue: literal(''),
        usedBy: ['packages/backend/src/config.ts'],
    }),
    defineEnv({
        key: 'LANGFUSE_METADATA_MIRROR_PUBLIC_KEY',
        owner: 'backend',
        stage: 'runtime',
        section: 'trace',
        required: false,
        secret: true,
        kind: 'string',
        description:
            'Langfuse public key used for Basic Auth on metadata mirror export.',
        defaultValue: literal(''),
        usedBy: ['packages/backend/src/config.ts'],
    }),
    defineEnv({
        key: 'LANGFUSE_METADATA_MIRROR_SECRET_KEY',
        owner: 'backend',
        stage: 'runtime',
        section: 'trace',
        required: false,
        secret: true,
        kind: 'string',
        description:
            'Langfuse secret key used for Basic Auth on metadata mirror export.',
        defaultValue: literal(''),
        usedBy: ['packages/backend/src/config.ts'],
    }),
    defineEnv({
        key: 'LANGFUSE_METADATA_MIRROR_TIMEOUT_MS',
        owner: 'backend',
        stage: 'runtime',
        section: 'trace',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'HTTP timeout budget in milliseconds for metadata mirror export to Langfuse.',
        defaultValue: literal(1500),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'FRAME_ANCESTORS',
        owner: 'shared',
        stage: 'tooling',
        section: 'web',
        required: false,
        secret: false,
        kind: 'csv',
        description:
            'CSP frame-ancestors allowlist used by backend responses and web dev tooling.',
        defaultValue: literal([
            "'self'",
            'https://ai.jordanmakes.dev',
            'http://localhost:8080',
            'http://localhost:3000',
        ]),
        usedBy: [
            'packages/backend/src/config.ts',
            'packages/web/vite.config.ts',
        ],
    }),

    defineEnv({
        key: 'DISCORD_TOKEN',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'discord-bot',
        required: true,
        secret: true,
        kind: 'string',
        description: 'Discord bot token used to authenticate the bot client.',
        defaultValue: noDefault(),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'DISCORD_CLIENT_ID',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'discord-bot',
        required: true,
        secret: false,
        kind: 'string',
        description: 'Discord application client ID.',
        defaultValue: noDefault(),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'DISCORD_GUILD_IDS',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'discord-bot',
        required: true,
        secret: false,
        kind: 'csv',
        description:
            'Comma-separated Discord guild IDs used for command registration.',
        defaultValue: noDefault(),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'DISCORD_USER_ID',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'discord-bot',
        required: true,
        secret: false,
        kind: 'string',
        description:
            'Developer Discord user ID used for privileged bot actions.',
        defaultValue: noDefault(),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'DISCORD_SUPERUSER_IDS',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'discord-bot',
        required: false,
        secret: false,
        kind: 'csv',
        description:
            'Comma-separated Discord user IDs allowed to review incidents through Discord commands.',
        defaultValue: noDefault(),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'PROMPT_CONFIG_PATH',
        owner: 'shared',
        stage: 'bootstrap',
        section: 'prompts',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Optional path to a YAML file with shared prompt overrides for backend and Discord runtimes.',
        defaultValue: noDefault(),
        usedBy: [
            'packages/backend/src/config.ts',
            'packages/discord-bot/src/config.ts',
        ],
    }),

    defineEnv({
        key: 'BOT_PROFILE_ID',
        owner: 'discord-bot',
        stage: 'bootstrap',
        section: 'prompts',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Stable profile identifier for the bot runtime persona overlay.',
        defaultValue: literal('footnote'),
        usedBy: ['packages/discord-bot/src/config/profile.ts'],
    }),

    defineEnv({
        key: 'BOT_PROFILE_DISPLAY_NAME',
        owner: 'discord-bot',
        stage: 'bootstrap',
        section: 'prompts',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Human-readable profile name for bot runtime persona overlay.',
        defaultValue: literal('Footnote'),
        usedBy: ['packages/discord-bot/src/config/profile.ts'],
    }),

    defineEnv({
        key: 'BOT_PROFILE_PROMPT_OVERLAY',
        owner: 'discord-bot',
        stage: 'bootstrap',
        section: 'prompts',
        required: false,
        secret: true,
        kind: 'string',
        description:
            'Optional inline prompt overlay text for bot profile behavior.',
        defaultValue: noDefault(),
        usedBy: ['packages/discord-bot/src/config/profile.ts'],
    }),

    defineEnv({
        key: 'BOT_PROFILE_PROMPT_OVERLAY_PATH',
        owner: 'discord-bot',
        stage: 'bootstrap',
        section: 'prompts',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Optional path to a text file containing bot profile prompt overlay instructions.',
        defaultValue: noDefault(),
        usedBy: ['packages/discord-bot/src/config/profile.ts'],
    }),

    defineEnv({
        key: 'BOT_PROFILE_MENTION_ALIASES',
        owner: 'discord-bot',
        stage: 'bootstrap',
        section: 'prompts',
        required: false,
        secret: false,
        kind: 'csv',
        description:
            'Optional comma-separated plain-text aliases that count as mentions for this bot profile.',
        defaultValue: noDefault(),
        usedBy: ['packages/discord-bot/src/config/profile.ts'],
    }),

    defineEnv({
        key: 'WEB_BASE_URL',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'urls',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Base URL for the web app that hosts trace and share pages.',
        defaultValue: derived(
            'Defaults to https://${FLY_APP_NAME}.fly.dev when FLY_APP_NAME is present, otherwise http://localhost:8080.',
            'http://localhost:8080'
        ),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'BACKEND_REQUEST_TIMEOUT_MS',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'backend',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Timeout budget for bot requests sent to the backend.',
        defaultValue: literal(180000),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'WEBHOOK_PORT',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'backend',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Local webhook listener port used by the Discord bot.',
        defaultValue: literal(3000),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'RATE_LIMIT_USER',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'rate-limits',
        required: false,
        secret: false,
        kind: 'boolean',
        description: 'Enables per-user Discord rate limiting.',
        defaultValue: literal(true),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'USER_RATE_LIMIT',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'rate-limits',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Maximum bot-handled messages per user in the rate window.',
        defaultValue: literal(5),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'USER_RATE_WINDOW_MS',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'rate-limits',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Per-user Discord rate-limit window in milliseconds.',
        defaultValue: literal(60000),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'RATE_LIMIT_CHANNEL',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'rate-limits',
        required: false,
        secret: false,
        kind: 'boolean',
        description: 'Enables per-channel Discord rate limiting.',
        defaultValue: literal(true),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'CHANNEL_RATE_LIMIT',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'rate-limits',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Maximum bot-handled messages per channel in the rate window.',
        defaultValue: literal(10),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'CHANNEL_RATE_WINDOW_MS',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'rate-limits',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Per-channel Discord rate-limit window in milliseconds.',
        defaultValue: literal(60000),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'RATE_LIMIT_GUILD',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'rate-limits',
        required: false,
        secret: false,
        kind: 'boolean',
        description: 'Enables per-guild Discord rate limiting.',
        defaultValue: literal(true),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'GUILD_RATE_LIMIT',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'rate-limits',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Maximum bot-handled messages per guild in the rate window.',
        defaultValue: literal(20),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'GUILD_RATE_WINDOW_MS',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'rate-limits',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Per-guild Discord rate-limit window in milliseconds.',
        defaultValue: literal(60000),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'ALLOW_THREAD_RESPONSES',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'threads',
        required: false,
        secret: false,
        kind: 'boolean',
        description: 'Allows the bot to reply in thread contexts by default.',
        defaultValue: literal(true),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'ALLOWED_THREAD_IDS',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'threads',
        required: false,
        secret: false,
        kind: 'csv',
        description:
            'Comma-separated thread IDs allowed when thread replies are restricted.',
        defaultValue: literal([]),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'BOT_BACK_AND_FORTH_LIMIT',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'bot-interaction',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Maximum bot-to-bot message exchanges allowed before intervention.',
        defaultValue: literal(2),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'BOT_BACK_AND_FORTH_COOLDOWN_MS',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'bot-interaction',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Cooldown after a bot-to-bot loop limit is reached.',
        defaultValue: literal(300000),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'BOT_BACK_AND_FORTH_TTL_MS',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'bot-interaction',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Conversation TTL for tracking bot-to-bot exchanges.',
        defaultValue: literal(600000),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'BOT_BACK_AND_FORTH_ACTION',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'bot-interaction',
        required: false,
        secret: false,
        kind: 'enum',
        description:
            'Action to take when the bot interaction limit is reached.',
        defaultValue: literal('react'),
        allowedValues: supportedBotInteractionActions,
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'BOT_BACK_AND_FORTH_REACTION',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'bot-interaction',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Emoji reaction used when bot interaction limit mode is react.',
        defaultValue: literal('👀'),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'BOT_DIRECT_INVOCATION_MIN_THRESHOLD',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'bot-interaction',
        required: false,
        secret: false,
        kind: 'number',
        description:
            'Minimum engagement score required before answering a bot-authored direct mention or reply.',
        defaultValue: literal(0.75),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'CATCHUP_AFTER_MESSAGES',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'catch-up',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Messages included after the last seen message in catch-up mode.',
        defaultValue: literal(10),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'CATCHUP_IF_MENTIONED_AFTER_MESSAGES',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'catch-up',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Catch-up message count when the bot was directly mentioned.',
        defaultValue: literal(5),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'STALE_COUNTER_TTL_MS',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'catch-up',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'TTL for stale counter tracking used by catch-up logic.',
        defaultValue: literal(3600000),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'CONTEXT_MANAGER_ENABLED',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'context-manager',
        required: false,
        secret: false,
        kind: 'boolean',
        description: 'Enables in-memory channel context tracking.',
        defaultValue: literal(true),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'CONTEXT_MANAGER_MAX_MESSAGES',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'context-manager',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Maximum messages kept per channel in the context manager.',
        defaultValue: literal(50),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'CONTEXT_MANAGER_RETENTION_MS',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'context-manager',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Message retention window for channel context state.',
        defaultValue: literal(3600000),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'CONTEXT_MANAGER_EVICTION_INTERVAL_MS',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'context-manager',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Eviction interval for stale channel context state.',
        defaultValue: literal(300000),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'REALTIME_FILTER_ENABLED',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'engagement',
        required: false,
        secret: false,
        kind: 'boolean',
        description: 'Enables the realtime engagement filter.',
        defaultValue: literal(true),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'ENGAGEMENT_WEIGHT_MENTION',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'engagement',
        required: false,
        secret: false,
        kind: 'number',
        description: 'Weight applied to direct mention signals.',
        defaultValue: literal(0.3),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'ENGAGEMENT_WEIGHT_QUESTION',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'engagement',
        required: false,
        secret: false,
        kind: 'number',
        description: 'Weight applied to question signals.',
        defaultValue: literal(0.2),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'ENGAGEMENT_WEIGHT_TECHNICAL',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'engagement',
        required: false,
        secret: false,
        kind: 'number',
        description: 'Weight applied to technical-language signals.',
        defaultValue: literal(0.15),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'ENGAGEMENT_WEIGHT_HUMAN_ACTIVITY',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'engagement',
        required: false,
        secret: false,
        kind: 'number',
        description: 'Weight applied to recent-human-activity signals.',
        defaultValue: literal(0.15),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'ENGAGEMENT_WEIGHT_BOT_NOISE',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'engagement',
        required: false,
        secret: false,
        kind: 'number',
        description: 'Weight applied to bot noise as a negative signal.',
        defaultValue: literal(0.05),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'ENGAGEMENT_WEIGHT_DM_BOOST',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'engagement',
        required: false,
        secret: false,
        kind: 'number',
        description: 'DM score multiplier used by engagement scoring.',
        defaultValue: literal(1.5),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'ENGAGEMENT_WEIGHT_DECAY',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'engagement',
        required: false,
        secret: false,
        kind: 'number',
        description: 'Time decay factor reserved for engagement scoring.',
        defaultValue: literal(0.05),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'ENGAGEMENT_IGNORE_MODE',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'engagement',
        required: false,
        secret: false,
        kind: 'enum',
        description: 'How the bot acknowledges skipped engagement decisions.',
        defaultValue: literal('silent'),
        allowedValues: supportedEngagementIgnoreModes,
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'ENGAGEMENT_REACTION_EMOJI',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'engagement',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Emoji reaction used when engagement ignore mode is react.',
        defaultValue: literal('👍'),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'ENGAGEMENT_MIN_THRESHOLD',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'engagement',
        required: false,
        secret: false,
        kind: 'number',
        description: 'Minimum engagement score required before responding.',
        defaultValue: literal(0.5),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'ENGAGEMENT_PROBABILISTIC_LOW',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'engagement',
        required: false,
        secret: false,
        kind: 'number',
        description: 'Lower bound of the LLM-refinement grey band.',
        defaultValue: literal(0.4),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'ENGAGEMENT_PROBABILISTIC_HIGH',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'engagement',
        required: false,
        secret: false,
        kind: 'number',
        description: 'Upper bound of the LLM-refinement grey band.',
        defaultValue: literal(0.6),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'ENGAGEMENT_ENABLE_LLM_REFINEMENT',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'engagement',
        required: false,
        secret: false,
        kind: 'boolean',
        description: 'Enables the optional engagement refinement pass.',
        defaultValue: literal(false),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'DISCORD_BOT_LOG_FULL_CONTEXT',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'debug',
        required: false,
        secret: false,
        kind: 'boolean',
        description: 'Enables verbose context logging in the Discord bot.',
        defaultValue: literal(false),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'IMAGE_DEFAULT_TEXT_MODEL',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'image',
        required: false,
        secret: false,
        kind: 'string',
        description: 'Default text model used by image prompting flows.',
        defaultValue: literal('gpt-4.1-mini'),
        usedBy: ['packages/discord-bot/src/config/imageConfig.ts'],
    }),

    defineEnv({
        key: 'IMAGE_DEFAULT_IMAGE_MODEL',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'image',
        required: false,
        secret: false,
        kind: 'string',
        description: 'Default image render model.',
        defaultValue: literal('gpt-image-1-mini'),
        usedBy: ['packages/discord-bot/src/config/imageConfig.ts'],
    }),

    defineEnv({
        key: 'IMAGE_DEFAULT_QUALITY',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'image',
        required: false,
        secret: false,
        kind: 'enum',
        description: 'Default image quality preset.',
        defaultValue: literal('low'),
        allowedValues: ['low', 'medium', 'high', 'auto'],
        usedBy: ['packages/discord-bot/src/config/imageConfig.ts'],
    }),

    defineEnv({
        key: 'IMAGE_DEFAULT_OUTPUT_FORMAT',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'image',
        required: false,
        secret: false,
        kind: 'enum',
        description: 'Default image output format.',
        defaultValue: literal('png'),
        allowedValues: ['png', 'webp', 'jpeg'],
        usedBy: ['packages/discord-bot/src/config/imageConfig.ts'],
    }),

    defineEnv({
        key: 'IMAGE_DEFAULT_OUTPUT_COMPRESSION',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'image',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Default output compression for generated images.',
        defaultValue: literal(100),
        usedBy: ['packages/discord-bot/src/config/imageConfig.ts'],
    }),

    defineEnv({
        key: 'IMAGE_PROMPT_MAX_INPUT_CHARS',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'image',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Maximum prompt length allowed for image generation input/storage policy. Values above 8000 are clamped to 8000 by runtime config parsing (with a warning log).',
        defaultValue: literal(8000),
        usedBy: ['packages/discord-bot/src/config/imageConfig.ts'],
    }),

    defineEnv({
        key: 'IMAGE_TOKENS_PER_REFRESH',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'image',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Token allowance granted each image refresh interval.',
        defaultValue: literal(10),
        usedBy: ['packages/discord-bot/src/config/imageConfig.ts'],
    }),

    defineEnv({
        key: 'IMAGE_TOKEN_REFRESH_INTERVAL_MS',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'image',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Refresh interval for replenishing image tokens.',
        defaultValue: literal(86400000),
        usedBy: ['packages/discord-bot/src/config/imageConfig.ts'],
    }),

    defineEnv({
        key: 'IMAGE_MODEL_MULTIPLIERS',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'image',
        required: false,
        secret: false,
        kind: 'json',
        description: 'JSON object with model-specific image token multipliers.',
        defaultValue: literal({
            'gpt-image-1-mini': 1,
            'gpt-image-1': 2,
            'gpt-image-1.5': 2,
        }),
        usedBy: ['packages/discord-bot/src/config/imageConfig.ts'],
    }),

    defineEnv({
        key: 'IMAGE_MODEL_MULTIPLIER_<MODEL_NAME>',
        isPattern: true,
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'image',
        required: false,
        secret: false,
        kind: 'number',
        description:
            'Per-model image multiplier override using IMAGE_MODEL_MULTIPLIER_<MODEL_NAME> naming.',
        defaultValue: noDefault(),
        notes: [
            'These override the shared IMAGE_MODEL_MULTIPLIERS map for a single model.',
        ],
        usedBy: ['packages/discord-bot/src/config/imageConfig.ts'],
    }),

    defineEnv({
        key: 'CLOUDINARY_CLOUD_NAME',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'image',
        required: false,
        secret: false,
        kind: 'string',
        description: 'Cloudinary cloud name used for image uploads.',
        defaultValue: noDefault(),
        usedBy: ['packages/discord-bot/src/config/imageConfig.ts'],
    }),

    defineEnv({
        key: 'CLOUDINARY_API_KEY',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'image',
        required: false,
        secret: true,
        kind: 'string',
        description: 'Cloudinary API key used for image uploads.',
        defaultValue: noDefault(),
        usedBy: ['packages/discord-bot/src/config/imageConfig.ts'],
    }),

    defineEnv({
        key: 'CLOUDINARY_API_SECRET',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'image',
        required: false,
        secret: true,
        kind: 'string',
        description: 'Cloudinary API secret used for image uploads.',
        defaultValue: noDefault(),
        usedBy: ['packages/discord-bot/src/config/imageConfig.ts'],
    }),

    defineEnv({
        key: 'DATA_DIR',
        owner: 'backend',
        stage: 'runtime',
        section: 'backend-server',
        required: false,
        secret: false,
        kind: 'string',
        description: 'Directory used for backend persistent data on disk.',
        defaultValue: literal('/data'),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'HOST',
        owner: 'backend',
        stage: 'runtime',
        section: 'backend-server',
        required: false,
        secret: false,
        kind: 'string',
        description: 'Host/interface the backend binds to.',
        defaultValue: literal('::'),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'PORT',
        owner: 'backend',
        stage: 'runtime',
        section: 'backend-server',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Port the backend listens on.',
        defaultValue: literal(3000),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'WEB_TRUST_PROXY',
        owner: 'backend',
        stage: 'runtime',
        section: 'backend-server',
        required: false,
        secret: false,
        kind: 'boolean',
        description: 'Enables Express trust proxy behavior for web requests.',
        defaultValue: literal(false),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'DEFAULT_MODEL',
        owner: 'backend',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'string',
        description: 'Default model used by backend chat flows.',
        defaultValue: literal('gpt-5-mini'),
        usedBy: ['packages/backend/src/config.ts'],
    }),
    defineEnv({
        key: 'MODEL_PROFILE_CATALOG_PATH',
        owner: 'backend',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Optional path to a YAML model profile catalog used for backend model routing.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),
    defineEnv({
        key: 'DEFAULT_PROFILE_ID',
        owner: 'backend',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Default model profile ID used when backend model selection input is empty or invalid.',
        defaultValue: literal('openai-text-medium'),
        usedBy: ['packages/backend/src/config.ts'],
    }),
    defineEnv({
        key: 'PLANNER_PROFILE_ID',
        owner: 'backend',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Model profile ID used for planner calls so planner and response profiles can differ.',
        defaultValue: literal('openai-text-fast'),
        usedBy: ['packages/backend/src/config.ts'],
    }),
    defineEnv({
        key: 'PLANNER_STRUCTURED_OUTPUT_ENABLED',
        owner: 'backend',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'boolean',
        description:
            'When true, planner execution uses structured function-calling output when available.',
        defaultValue: literal(true),
        usedBy: ['packages/backend/src/config.ts'],
    }),
    defineEnv({
        key: 'PLANNER_ALLOW_TEXT_JSON_COMPATIBILITY_FALLBACK',
        owner: 'backend',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'boolean',
        description:
            'When true, planner falls back to text JSON compatibility parsing when structured planner execution fails.',
        defaultValue: literal(false),
        usedBy: ['packages/backend/src/config.ts'],
    }),
    defineEnv({
        key: 'REALTIME_DEFAULT_MODEL',
        owner: 'shared',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'enum',
        description: 'Default model used by realtime voice sessions.',
        defaultValue: literal('gpt-realtime-mini'),
        allowedValues: supportedOpenAIRealtimeModels,
        usedBy: [
            'packages/backend/src/config.ts',
            'packages/discord-bot/src/config.ts',
        ],
    }),
    defineEnv({
        key: 'REALTIME_DEFAULT_VOICE',
        owner: 'shared',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'enum',
        description: 'Default voice used by realtime voice sessions.',
        defaultValue: literal('echo'),
        allowedValues: supportedOpenAITtsVoices,
        usedBy: [
            'packages/backend/src/config.ts',
            'packages/discord-bot/src/config.ts',
        ],
    }),
    defineEnv({
        key: 'REALTIME_TURN_DETECTION',
        owner: 'shared',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'enum',
        description:
            'Turn detection strategy for realtime voice sessions (server_vad or semantic_vad).',
        defaultValue: literal('server_vad'),
        allowedValues: supportedOpenAIRealtimeTurnDetections,
        usedBy: [
            'packages/backend/src/config.ts',
            'packages/discord-bot/src/config.ts',
        ],
    }),
    defineEnv({
        key: 'REALTIME_VAD_THRESHOLD',
        owner: 'shared',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'number',
        description:
            'Optional server VAD threshold (0-1). Leave unset to use provider defaults.',
        defaultValue: noDefault(),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),
    defineEnv({
        key: 'REALTIME_VAD_SILENCE_MS',
        owner: 'shared',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Optional server VAD silence duration in milliseconds. Leave unset to use provider defaults.',
        defaultValue: noDefault(),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),
    defineEnv({
        key: 'REALTIME_VAD_PREFIX_MS',
        owner: 'shared',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Optional server VAD prefix padding in milliseconds. Leave unset to use provider defaults.',
        defaultValue: noDefault(),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),
    defineEnv({
        key: 'REALTIME_VAD_CREATE_RESPONSE',
        owner: 'shared',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'boolean',
        description:
            'When true, the provider auto-creates a response after each detected turn.',
        defaultValue: noDefault(),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),
    defineEnv({
        key: 'REALTIME_VAD_INTERRUPT_RESPONSE',
        owner: 'shared',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'boolean',
        description:
            'When true, allow new speech to interrupt an in-flight response.',
        defaultValue: noDefault(),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),
    defineEnv({
        key: 'REALTIME_VAD_EAGERNESS',
        owner: 'shared',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'enum',
        description:
            'Optional semantic VAD eagerness (low|medium|high|auto). Leave unset to use provider defaults.',
        defaultValue: noDefault(),
        allowedValues: supportedOpenAIRealtimeVadEagerness,
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),
    defineEnv({
        key: 'REALTIME_GREETING',
        owner: 'discord-bot',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Greeting text sent when a realtime voice session starts. Supports {bot} placeholder.',
        defaultValue: literal('Hey, {bot} here.'),
        usedBy: ['packages/discord-bot/src/config.ts'],
    }),

    defineEnv({
        key: 'DEFAULT_REASONING_EFFORT',
        owner: 'backend',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'enum',
        description: 'Default reasoning effort for backend chat flows.',
        defaultValue: literal('low'),
        allowedValues: supportedReasoningEfforts,
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'DEFAULT_VERBOSITY',
        owner: 'backend',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'enum',
        description: 'Default verbosity for backend chat flows.',
        defaultValue: literal('low'),
        allowedValues: supportedVerbosityLevels,
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'OPENAI_REQUEST_TIMEOUT_MS',
        owner: 'backend',
        stage: 'runtime',
        section: 'openai',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Timeout budget for backend OpenAI requests.',
        defaultValue: literal(180000),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'ALLOWED_ORIGINS',
        owner: 'backend',
        stage: 'runtime',
        section: 'web',
        required: false,
        secret: false,
        kind: 'csv',
        description: 'CORS allowlist for web origins.',
        defaultValue: literal([
            'http://localhost:8080',
            'http://localhost:3000',
            'https://ai.jordanmakes.dev',
        ]),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'REFLECT_SERVICE_TOKEN',
        owner: 'backend',
        stage: 'runtime',
        section: 'reflect',
        required: false,
        secret: true,
        kind: 'string',
        description: 'Shared secret for trusted reflect callers.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'REFLECT_API_MAX_BODY_BYTES',
        owner: 'backend',
        stage: 'runtime',
        section: 'reflect',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Maximum request body size for /api/chat.',
        defaultValue: literal(262144),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'TRACE_API_MAX_BODY_BYTES',
        owner: 'backend',
        stage: 'runtime',
        section: 'trace',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Maximum request body size for /api/traces.',
        defaultValue: literal(262144),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_WORKFLOW_MODE_ID',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'enum',
        allowedValues: ['balanced', 'grounded'] as const,
        description:
            'Chat workflow mode selection used by backend orchestration.',
        defaultValue: literal('grounded'),
        usedBy: ['packages/backend/src/config.ts'],
    }),
    defineEnv({
        key: 'CHAT_REVIEW_LOOP_ENABLED',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'boolean',
        description:
            'Enables backend chat review-loop orchestration for iterative review cycles.',
        defaultValue: literal(false),
        usedBy: ['packages/backend/src/config.ts'],
    }),
    defineEnv({
        key: 'CHAT_REVIEW_LOOP_MAX_ITERATIONS',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Maximum number of backend review-loop iterations when review loop is enabled.',
        defaultValue: literal(2),
        usedBy: ['packages/backend/src/config.ts'],
    }),
    defineEnv({
        key: 'CHAT_REVIEW_LOOP_MAX_DURATION_MS',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Maximum total review-loop duration in milliseconds when review loop is enabled.',
        defaultValue: literal(15000),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_MAX_REQUEST_REVIEW_CYCLES',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Maximum manual maxReviewCycles override accepted from /api/chat requests before backend clamping.',
        defaultValue: literal(7),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_CONTEXT_WEB_SEARCH_ENABLED',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'boolean',
        description:
            'Enables web-search context integration execution in chat workflow orchestration.',
        defaultValue: literal(true),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_CONTEXT_WEB_SEARCH_PROVIDER_PRIORITY',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'csv',
        description:
            'Ordered provider fallback list for web-search context integration (`searxng`, `brave`, `serpapi`).',
        defaultValue: literal(['searxng', 'brave', 'serpapi']),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_CONTEXT_WEB_SEARCH_SEARXNG_BASE_URL',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'string',
        description: 'Base URL for SearXNG web-search provider.',
        defaultValue: literal(''),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_CONTEXT_WEB_SEARCH_BRAVE_API_KEY',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: true,
        kind: 'string',
        description: 'Brave API key for web-search provider.',
        defaultValue: literal(''),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_CONTEXT_WEB_SEARCH_SERPAPI_API_KEY',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: true,
        kind: 'string',
        description: 'SerpAPI key for web-search provider.',
        defaultValue: literal(''),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_CONTEXT_WEB_SEARCH_SERPAPI_ENGINE',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Optional SerpAPI engine override for web search (for example `google`).',
        defaultValue: literal(''),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_CONTEXT_WEB_SEARCH_SERPAPI_GL',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Optional SerpAPI country hint (`gl`) for web-search requests.',
        defaultValue: literal(''),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_CONTEXT_WEB_SEARCH_SERPAPI_HL',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Optional SerpAPI language hint (`hl`) for web-search requests.',
        defaultValue: literal(''),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_CONTEXT_WEB_SEARCH_PROVIDER_TIMEOUT_MS',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Timeout budget for each web-search provider HTTP request in milliseconds.',
        defaultValue: literal(12000),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_CONTEXT_WEB_SEARCH_MAX_RESULTS',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Maximum number of normalized web-search results retained per provider attempt.',
        defaultValue: literal(6),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_CONTEXT_WEB_SEARCH_OPENAI_NATIVE_FROM_HINTS_ENABLED',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'boolean',
        description:
            'Enables optional OpenAI-native follow-up search from web-search context-step hints.',
        defaultValue: literal(true),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_ENABLED',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'boolean',
        description:
            'Enables reverse-image context integration execution in chat workflow orchestration.',
        defaultValue: literal(true),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_AUTORUN',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'boolean',
        description:
            'Automatically requests reverse-image context integration when image attachments are present.',
        defaultValue: literal(true),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_MAX_MATCHES_PER_IMAGE',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Maximum number of reverse-image source matches surfaced per image attachment.',
        defaultValue: literal(2),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_PROVIDER',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'enum',
        allowedValues: ['none', 'serpapi'] as const,
        description:
            'Reverse-image provider mode (`none` or `serpapi`). `none` keeps the integration fail-open unavailable.',
        defaultValue: literal('none'),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_SERPAPI_API_KEY',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: true,
        kind: 'string',
        description:
            'SerpAPI key used when reverse-image provider mode is set to `serpapi`.',
        defaultValue: literal(''),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_PROVIDER_TIMEOUT_MS',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Timeout budget for reverse-image provider HTTP requests in milliseconds.',
        defaultValue: literal(12000),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'EXECUTION_CONTRACT_TRUSTGRAPH_ENABLED',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'boolean',
        description:
            'Enables advisory Execution Contract TrustGraph retrieval integration.',
        defaultValue: literal(false),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'EXECUTION_CONTRACT_TRUSTGRAPH_KILL_SWITCH',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'boolean',
        description:
            'Emergency kill switch for external TrustGraph retrieval while preserving local chat behavior.',
        defaultValue: literal(false),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'EXECUTION_CONTRACT_TRUSTGRAPH_POLICY_ID',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Policy ID sent to TrustGraph adapters for advisory retrieval scope decisions.',
        defaultValue: literal('server_chat_runtime_policy'),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'EXECUTION_CONTRACT_TRUSTGRAPH_TIMEOUT_MS',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Timeout budget in milliseconds for TrustGraph advisory retrieval calls.',
        defaultValue: literal(800),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'EXECUTION_CONTRACT_TRUSTGRAPH_MAX_CALLS',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Maximum number of TrustGraph advisory retrieval calls per request.',
        defaultValue: literal(1),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'EXECUTION_CONTRACT_TRUSTGRAPH_ADAPTER_MODE',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'enum',
        allowedValues: ['none', 'stub', 'http'] as const,
        description:
            'Adapter mode for TrustGraph retrieval integration (`none`, `stub`, or `http`).',
        defaultValue: literal('none'),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'EXECUTION_CONTRACT_TRUSTGRAPH_STUB_ADAPTER_MODE',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'enum',
        allowedValues: ['success', 'failure', 'timeout', 'poisoned'] as const,
        description:
            'Stub adapter response mode used for local or test TrustGraph wiring.',
        defaultValue: literal('success'),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'EXECUTION_CONTRACT_TRUSTGRAPH_ADAPTER_ENDPOINT_URL',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'HTTP endpoint URL for TrustGraph adapter mode when adapter mode is `http`.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'EXECUTION_CONTRACT_TRUSTGRAPH_ADAPTER_API_TOKEN',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: true,
        kind: 'string',
        description:
            'Optional API token sent to the TrustGraph adapter when using HTTP mode.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'EXECUTION_CONTRACT_TRUSTGRAPH_ADAPTER_CONFIG_REF',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Optional adapter configuration reference passed with TrustGraph HTTP calls.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'EXECUTION_CONTRACT_TRUSTGRAPH_OWNERSHIP_BINDING_MODE',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'enum',
        allowedValues: ['none', 'http'] as const,
        description:
            'Ownership binding mode used by TrustGraph tenancy checks (`none` or `http`).',
        defaultValue: literal('none'),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'EXECUTION_CONTRACT_TRUSTGRAPH_OWNERSHIP_VALIDATOR_ID',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Ownership validator ID used when TrustGraph ownership binding is active.',
        defaultValue: literal('backend_tenancy_http_v1'),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'EXECUTION_CONTRACT_TRUSTGRAPH_OWNERSHIP_ENDPOINT_URL',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'HTTP ownership validator endpoint URL used when ownership binding mode is `http`.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'EXECUTION_CONTRACT_TRUSTGRAPH_OWNERSHIP_API_TOKEN',
        owner: 'backend',
        stage: 'runtime',
        section: 'chat-workflow',
        required: false,
        secret: true,
        kind: 'string',
        description:
            'Optional API token used by the TrustGraph ownership validator endpoint.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'WEB_API_RATE_LIMIT_IP',
        owner: 'backend',
        stage: 'runtime',
        section: 'rate-limits',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Public web API rate limit per IP.',
        defaultValue: literal(3),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'WEB_API_RATE_LIMIT_IP_WINDOW_MS',
        owner: 'backend',
        stage: 'runtime',
        section: 'rate-limits',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Window for the public web API per-IP rate limit.',
        defaultValue: literal(60000),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'WEB_API_RATE_LIMIT_SESSION',
        owner: 'backend',
        stage: 'runtime',
        section: 'rate-limits',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Public web API rate limit per session.',
        defaultValue: literal(5),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'WEB_API_RATE_LIMIT_SESSION_WINDOW_MS',
        owner: 'backend',
        stage: 'runtime',
        section: 'rate-limits',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Window for the public web API per-session rate limit.',
        defaultValue: literal(60000),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'REFLECT_SERVICE_RATE_LIMIT',
        owner: 'backend',
        stage: 'runtime',
        section: 'rate-limits',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Trusted reflect service rate limit.',
        defaultValue: literal(30),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'REFLECT_SERVICE_RATE_LIMIT_WINDOW_MS',
        owner: 'backend',
        stage: 'runtime',
        section: 'rate-limits',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Window for the trusted reflect service rate limit.',
        defaultValue: literal(60000),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'TRACE_API_RATE_LIMIT',
        owner: 'backend',
        stage: 'runtime',
        section: 'rate-limits',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Trace API write rate limit.',
        defaultValue: literal(10),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'TRACE_API_RATE_LIMIT_WINDOW_MS',
        owner: 'backend',
        stage: 'runtime',
        section: 'rate-limits',
        required: false,
        secret: false,
        kind: 'integer',
        description: 'Window for the trace API write rate limit.',
        defaultValue: literal(60000),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'TURNSTILE_SECRET_KEY',
        owner: 'backend',
        stage: 'runtime',
        section: 'turnstile',
        required: false,
        secret: true,
        kind: 'string',
        description: 'Cloudflare Turnstile secret key.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'TURNSTILE_SITE_KEY',
        owner: 'backend',
        stage: 'runtime',
        section: 'turnstile',
        required: false,
        secret: false,
        kind: 'string',
        description:
            'Cloudflare Turnstile site key returned to the web client.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'TURNSTILE_ALLOWED_HOSTNAMES',
        owner: 'backend',
        stage: 'runtime',
        section: 'turnstile',
        required: false,
        secret: false,
        kind: 'csv',
        description:
            'Optional allowlist of hostnames accepted in Turnstile responses.',
        defaultValue: literal([]),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'GITHUB_WEBHOOK_SECRET',
        owner: 'backend',
        stage: 'runtime',
        section: 'webhooks',
        required: false,
        secret: true,
        kind: 'string',
        description: 'GitHub webhook signing secret.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'GITHUB_WEBHOOK_MAX_BODY_BYTES',
        owner: 'backend',
        stage: 'runtime',
        section: 'webhooks',
        required: false,
        secret: false,
        kind: 'integer',
        description:
            'Maximum request body size for the GitHub webhook endpoint.',
        defaultValue: literal(262144),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'PROVENANCE_SQLITE_PATH',
        owner: 'backend',
        stage: 'runtime',
        section: 'storage',
        required: false,
        secret: false,
        kind: 'string',
        description: 'SQLite path for provenance trace storage.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),

    defineEnv({
        key: 'INCIDENT_SQLITE_PATH',
        owner: 'backend',
        stage: 'runtime',
        section: 'storage',
        required: false,
        secret: false,
        kind: 'string',
        description: 'SQLite path for incident storage.',
        defaultValue: noDefault(),
        usedBy: ['packages/backend/src/config.ts'],
    }),
] as const satisfies readonly EnvSpecEntry[];

// Keep the ordered list export because it is the easiest form to browse in docs
// and tooling when someone wants to scan the full environment surface.
/**
 * Alias kept for code that wants the full ordered spec without depending on the
 * internal `envEntries` name.
 */
export const envSpec = envEntries;

type EnvEntries = typeof envEntries;

type EnvSpecByKey = {
    [Entry in EnvEntries[number] as Entry['key']]: Entry;
};

type LiteralEnvEntry = Extract<
    EnvEntries[number],
    { defaultValue: { kind: 'literal' } }
>;

type EnvDefaultValues = {
    [Entry in LiteralEnvEntry as Entry['key']]: Entry['defaultValue']['value'];
};

const duplicateEnvKeys = (() => {
    const seenKeys = new Set<string>();
    const duplicates = new Set<string>();

    for (const entry of envEntries) {
        if (seenKeys.has(entry.key)) {
            duplicates.add(entry.key);
            continue;
        }

        seenKeys.add(entry.key);
    }

    return [...duplicates];
})();

if (duplicateEnvKeys.length > 0) {
    throw new Error(
        `envEntries contains duplicate keys: ${duplicateEnvKeys.join(', ')}. Fix envEntries before building envSpecByKey or envDefaultValues.`
    );
}

// Handy lookup for scripts, docs, and future tooling that want one env key at
// a time without manually searching the full ordered list above.
/**
 * Fast lookup table keyed by env variable name.
 */
export const envSpecByKey = Object.fromEntries(
    envEntries.map((entry) => [entry.key, entry])
) as EnvSpecByKey;

// Only literal env-backed defaults belong here. Derived defaults stay on the
// env entry itself so operators can clearly tell which values come from env.
/**
 * Plain object of literal defaults only, for consumers that need concrete
 * fallback values at runtime.
 */
export const envDefaultValues = Object.fromEntries(
    envEntries
        .filter(
            (entry): entry is LiteralEnvEntry =>
                entry.defaultValue.kind === 'literal' &&
                !('isPattern' in entry && entry.isPattern === true)
        )
        .map((entry) => [entry.key, entry.defaultValue.value])
) as EnvDefaultValues;

const BOOTSTRAP_ENV_ALLOWLIST = new Set<string>([
    'FOOTNOTE_SERVER_SETTINGS_PATH',
    'NODE_ENV',
    'FLY_APP_NAME',
    'PROMPT_CONFIG_PATH',
    'TRACE_API_TOKEN_FILE',
]);

/**
 * Runtime source classification for each env key.
 */
export const envConfigSourceByKey = Object.fromEntries(
    envEntries.map((entry) => {
        const configSource = entry.secret
            ? 'secret_env'
            : BOOTSTRAP_ENV_ALLOWLIST.has(entry.key)
              ? 'bootstrap_env'
              : 'settings_yaml';
        return [entry.key, configSource];
    })
) as Record<
    EnvEntries[number]['key'],
    'secret_env' | 'settings_yaml' | 'bootstrap_env'
>;
