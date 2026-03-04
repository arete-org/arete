/**
 * @description: Shared environment metadata and canonical defaults used across packages.
 * @footnote-scope: interface
 * @footnote-module: EnvSpec
 * @footnote-risk: medium - Wrong defaults or metadata can create cross-package config drift.
 * @footnote-ethics: medium - Env defaults influence safety, logging, and transparency behavior.
 */

import { defineEnv, derived, literal, noDefault } from './env-factories.js';
import { runtimeFallbacks } from './runtime-fallbacks.js';
import type { EnvSpecEntry } from './types.js';

// This file is the single source of truth for environment metadata.
// Each env variable is declared once below, and every exported view is derived
// from that one declaration.
export const envEntries = [
    defineEnv({
        key: "OPENAI_API_KEY",
        owner: "shared",
        stage: "runtime",
        section: "openai",
        required: true,
        secret: true,
        kind: "string",
        description: "OpenAI API key used by the bot and backend.",
        defaultValue: noDefault(),
        usedBy: [
            "packages/backend/src/config.ts",
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "INCIDENT_PSEUDONYMIZATION_SECRET",
        owner: "shared",
        stage: "runtime",
        section: "security",
        required: true,
        secret: true,
        kind: "string",
        description: "HMAC secret used to pseudonymize stored identifiers.",
        defaultValue: noDefault(),
        usedBy: [
            "packages/backend/src/config.ts",
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "LOG_DIR",
        owner: "shared",
        stage: "runtime",
        section: "logging",
        required: false,
        secret: false,
        kind: "string",
        description: "Directory where rotating log files are written.",
        defaultValue: literal("logs"),
        usedBy: [
            "packages/backend/src/config.ts",
            "packages/backend/src/utils/logger.ts",
            "packages/discord-bot/src/config.ts",
            "packages/discord-bot/src/utils/logger.ts",
        ],
    }),

    defineEnv({
        key: "LOG_LEVEL",
        owner: "shared",
        stage: "runtime",
        section: "logging",
        required: false,
        secret: false,
        kind: "enum",
        description: "Logger verbosity level.",
        defaultValue: literal("debug"),
        allowedValues: [
            "error",
            "warn",
            "info",
            "http",
            "verbose",
            "debug",
            "silly",
        ],
        usedBy: [
            "packages/backend/src/config.ts",
            "packages/backend/src/utils/logger.ts",
            "packages/discord-bot/src/config.ts",
            "packages/discord-bot/src/utils/logger.ts",
        ],
    }),

    defineEnv({
        key: "NODE_ENV",
        owner: "shared",
        stage: "runtime",
        section: "runtime",
        required: false,
        secret: false,
        kind: "string",
        description: "Node runtime mode used for production/development branching.",
        defaultValue: literal("development"),
        usedBy: [
            "packages/backend/src/config.ts",
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "FLY_APP_NAME",
        owner: "shared",
        stage: "runtime",
        section: "runtime",
        required: false,
        secret: false,
        kind: "string",
        description: "Fly app name used to derive internal or public service URLs.",
        defaultValue: noDefault(),
        usedBy: [
            "packages/backend/src/config.ts",
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "BACKEND_BASE_URL",
        owner: "shared",
        stage: "runtime",
        section: "urls",
        required: false,
        secret: false,
        kind: "string",
        description: "Base URL used for bot-to-backend requests and the web dev proxy.",
        defaultValue: derived("Defaults to the Fly internal backend URL on Fly, otherwise http://localhost:3000.", "http://localhost:3000"),
        usedBy: [
            "packages/discord-bot/src/config.ts",
            "packages/web/vite.config.ts",
        ],
    }),

    defineEnv({
        key: "TRACE_API_TOKEN",
        owner: "shared",
        stage: "runtime",
        section: "trace",
        required: false,
        secret: true,
        kind: "string",
        description: "Shared secret for trusted trace ingestion requests.",
        defaultValue: noDefault(),
        usedBy: [
            "packages/backend/src/config.ts",
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "FRAME_ANCESTORS",
        owner: "shared",
        stage: "tooling",
        section: "web",
        required: false,
        secret: false,
        kind: "csv",
        description: "CSP frame-ancestors allowlist used by backend responses and web dev tooling.",
        defaultValue: literal([
            "'self'",
            "https://ai.jordanmakes.dev",
            "http://localhost:8080",
            "http://localhost:3000",
        ]),
        usedBy: [
            "packages/backend/src/config.ts",
            "packages/web/vite.config.ts",
        ],
    }),

    defineEnv({
        key: "DISCORD_TOKEN",
        owner: "discord-bot",
        stage: "runtime",
        section: "discord-bot",
        required: true,
        secret: true,
        kind: "string",
        description: "Discord bot token used to authenticate the bot client.",
        defaultValue: noDefault(),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "DISCORD_CLIENT_ID",
        owner: "discord-bot",
        stage: "runtime",
        section: "discord-bot",
        required: true,
        secret: false,
        kind: "string",
        description: "Discord application client ID.",
        defaultValue: noDefault(),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "DISCORD_GUILD_ID",
        owner: "discord-bot",
        stage: "runtime",
        section: "discord-bot",
        required: true,
        secret: false,
        kind: "string",
        description: "Primary Discord guild ID for command registration.",
        defaultValue: noDefault(),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "DISCORD_USER_ID",
        owner: "discord-bot",
        stage: "runtime",
        section: "discord-bot",
        required: true,
        secret: false,
        kind: "string",
        description: "Developer Discord user ID used for privileged bot actions.",
        defaultValue: noDefault(),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "PROMPT_CONFIG_PATH",
        owner: "discord-bot",
        stage: "bootstrap",
        section: "prompts",
        required: false,
        secret: false,
        kind: "string",
        description: "Optional path to a YAML file with prompt overrides.",
        defaultValue: noDefault(),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "WEB_BASE_URL",
        owner: "discord-bot",
        stage: "runtime",
        section: "urls",
        required: false,
        secret: false,
        kind: "string",
        description: "Base URL for the web app that hosts trace and share pages.",
        defaultValue: derived("Defaults to https://${FLY_APP_NAME}.fly.dev when FLY_APP_NAME is present, otherwise http://localhost:8080.", "http://localhost:8080"),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "BACKEND_REQUEST_TIMEOUT_MS",
        owner: "discord-bot",
        stage: "runtime",
        section: "backend",
        required: false,
        secret: false,
        kind: "integer",
        description: "Timeout budget for bot requests sent to the backend.",
        defaultValue: literal(180000),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "WEBHOOK_PORT",
        owner: "discord-bot",
        stage: "runtime",
        section: "backend",
        required: false,
        secret: false,
        kind: "integer",
        description: "Local webhook listener port used by the Discord bot.",
        defaultValue: literal(3000),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "RATE_LIMIT_USER",
        owner: "discord-bot",
        stage: "runtime",
        section: "rate-limits",
        required: false,
        secret: false,
        kind: "boolean",
        description: "Enables per-user Discord rate limiting.",
        defaultValue: literal(true),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "USER_RATE_LIMIT",
        owner: "discord-bot",
        stage: "runtime",
        section: "rate-limits",
        required: false,
        secret: false,
        kind: "integer",
        description: "Maximum bot-handled messages per user in the rate window.",
        defaultValue: literal(5),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "USER_RATE_WINDOW_MS",
        owner: "discord-bot",
        stage: "runtime",
        section: "rate-limits",
        required: false,
        secret: false,
        kind: "integer",
        description: "Per-user Discord rate-limit window in milliseconds.",
        defaultValue: literal(60000),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "RATE_LIMIT_CHANNEL",
        owner: "discord-bot",
        stage: "runtime",
        section: "rate-limits",
        required: false,
        secret: false,
        kind: "boolean",
        description: "Enables per-channel Discord rate limiting.",
        defaultValue: literal(true),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "CHANNEL_RATE_LIMIT",
        owner: "discord-bot",
        stage: "runtime",
        section: "rate-limits",
        required: false,
        secret: false,
        kind: "integer",
        description: "Maximum bot-handled messages per channel in the rate window.",
        defaultValue: literal(10),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "CHANNEL_RATE_WINDOW_MS",
        owner: "discord-bot",
        stage: "runtime",
        section: "rate-limits",
        required: false,
        secret: false,
        kind: "integer",
        description: "Per-channel Discord rate-limit window in milliseconds.",
        defaultValue: literal(60000),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "RATE_LIMIT_GUILD",
        owner: "discord-bot",
        stage: "runtime",
        section: "rate-limits",
        required: false,
        secret: false,
        kind: "boolean",
        description: "Enables per-guild Discord rate limiting.",
        defaultValue: literal(true),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "GUILD_RATE_LIMIT",
        owner: "discord-bot",
        stage: "runtime",
        section: "rate-limits",
        required: false,
        secret: false,
        kind: "integer",
        description: "Maximum bot-handled messages per guild in the rate window.",
        defaultValue: literal(20),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "GUILD_RATE_WINDOW_MS",
        owner: "discord-bot",
        stage: "runtime",
        section: "rate-limits",
        required: false,
        secret: false,
        kind: "integer",
        description: "Per-guild Discord rate-limit window in milliseconds.",
        defaultValue: literal(60000),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "ALLOW_THREAD_RESPONSES",
        owner: "discord-bot",
        stage: "runtime",
        section: "threads",
        required: false,
        secret: false,
        kind: "boolean",
        description: "Allows the bot to reply in thread contexts by default.",
        defaultValue: literal(true),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "ALLOWED_THREAD_IDS",
        owner: "discord-bot",
        stage: "runtime",
        section: "threads",
        required: false,
        secret: false,
        kind: "csv",
        description: "Comma-separated thread IDs allowed when thread replies are restricted.",
        defaultValue: literal([
            "",
        ]),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "BOT_MENTION_NAMES",
        owner: "discord-bot",
        stage: "runtime",
        section: "engagement",
        required: false,
        secret: false,
        kind: "csv",
        description: "Names that count as plain-text bot mentions.",
        defaultValue: literal([
            "footnote",
            "ari",
        ]),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "BOT_BACK_AND_FORTH_LIMIT",
        owner: "discord-bot",
        stage: "runtime",
        section: "bot-interaction",
        required: false,
        secret: false,
        kind: "integer",
        description: "Maximum bot-to-bot message exchanges allowed before intervention.",
        defaultValue: literal(2),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "BOT_BACK_AND_FORTH_COOLDOWN_MS",
        owner: "discord-bot",
        stage: "runtime",
        section: "bot-interaction",
        required: false,
        secret: false,
        kind: "integer",
        description: "Cooldown after a bot-to-bot loop limit is reached.",
        defaultValue: literal(300000),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "BOT_BACK_AND_FORTH_TTL_MS",
        owner: "discord-bot",
        stage: "runtime",
        section: "bot-interaction",
        required: false,
        secret: false,
        kind: "integer",
        description: "Conversation TTL for tracking bot-to-bot exchanges.",
        defaultValue: literal(600000),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "BOT_BACK_AND_FORTH_ACTION",
        owner: "discord-bot",
        stage: "runtime",
        section: "bot-interaction",
        required: false,
        secret: false,
        kind: "enum",
        description: "Action to take when the bot interaction limit is reached.",
        defaultValue: literal("react"),
        allowedValues: [
            "ignore",
            "react",
        ],
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "BOT_BACK_AND_FORTH_REACTION",
        owner: "discord-bot",
        stage: "runtime",
        section: "bot-interaction",
        required: false,
        secret: false,
        kind: "string",
        description: "Emoji reaction used when bot interaction limit mode is react.",
        defaultValue: literal("👀"),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "CATCHUP_AFTER_MESSAGES",
        owner: "discord-bot",
        stage: "runtime",
        section: "catch-up",
        required: false,
        secret: false,
        kind: "integer",
        description: "Messages included after the last seen message in catch-up mode.",
        defaultValue: literal(10),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "CATCHUP_IF_MENTIONED_AFTER_MESSAGES",
        owner: "discord-bot",
        stage: "runtime",
        section: "catch-up",
        required: false,
        secret: false,
        kind: "integer",
        description: "Catch-up message count when the bot was directly mentioned.",
        defaultValue: literal(5),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "STALE_COUNTER_TTL_MS",
        owner: "discord-bot",
        stage: "runtime",
        section: "catch-up",
        required: false,
        secret: false,
        kind: "integer",
        description: "TTL for stale counter tracking used by catch-up logic.",
        defaultValue: literal(3600000),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "CONTEXT_MANAGER_ENABLED",
        owner: "discord-bot",
        stage: "runtime",
        section: "context-manager",
        required: false,
        secret: false,
        kind: "boolean",
        description: "Enables in-memory channel context tracking.",
        defaultValue: literal(true),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "CONTEXT_MANAGER_MAX_MESSAGES",
        owner: "discord-bot",
        stage: "runtime",
        section: "context-manager",
        required: false,
        secret: false,
        kind: "integer",
        description: "Maximum messages kept per channel in the context manager.",
        defaultValue: literal(50),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "CONTEXT_MANAGER_RETENTION_MS",
        owner: "discord-bot",
        stage: "runtime",
        section: "context-manager",
        required: false,
        secret: false,
        kind: "integer",
        description: "Message retention window for channel context state.",
        defaultValue: literal(3600000),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "CONTEXT_MANAGER_EVICTION_INTERVAL_MS",
        owner: "discord-bot",
        stage: "runtime",
        section: "context-manager",
        required: false,
        secret: false,
        kind: "integer",
        description: "Eviction interval for stale channel context state.",
        defaultValue: literal(300000),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "COST_ESTIMATOR_ENABLED",
        owner: "discord-bot",
        stage: "runtime",
        section: "cost",
        required: false,
        secret: false,
        kind: "boolean",
        description: "Enables OpenAI cost tracking for the Discord bot.",
        defaultValue: literal(true),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "REALTIME_FILTER_ENABLED",
        owner: "discord-bot",
        stage: "runtime",
        section: "engagement",
        required: false,
        secret: false,
        kind: "boolean",
        description: "Enables the realtime engagement filter.",
        defaultValue: literal(true),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "ENGAGEMENT_WEIGHT_MENTION",
        owner: "discord-bot",
        stage: "runtime",
        section: "engagement",
        required: false,
        secret: false,
        kind: "number",
        description: "Weight applied to direct mention signals.",
        defaultValue: literal(0.3),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "ENGAGEMENT_WEIGHT_QUESTION",
        owner: "discord-bot",
        stage: "runtime",
        section: "engagement",
        required: false,
        secret: false,
        kind: "number",
        description: "Weight applied to question signals.",
        defaultValue: literal(0.2),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "ENGAGEMENT_WEIGHT_TECHNICAL",
        owner: "discord-bot",
        stage: "runtime",
        section: "engagement",
        required: false,
        secret: false,
        kind: "number",
        description: "Weight applied to technical-language signals.",
        defaultValue: literal(0.15),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "ENGAGEMENT_WEIGHT_HUMAN_ACTIVITY",
        owner: "discord-bot",
        stage: "runtime",
        section: "engagement",
        required: false,
        secret: false,
        kind: "number",
        description: "Weight applied to recent-human-activity signals.",
        defaultValue: literal(0.15),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "ENGAGEMENT_WEIGHT_COST_SATURATION",
        owner: "discord-bot",
        stage: "runtime",
        section: "engagement",
        required: false,
        secret: false,
        kind: "number",
        description: "Weight applied to cost saturation as a negative signal.",
        defaultValue: literal(0.1),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "ENGAGEMENT_WEIGHT_BOT_NOISE",
        owner: "discord-bot",
        stage: "runtime",
        section: "engagement",
        required: false,
        secret: false,
        kind: "number",
        description: "Weight applied to bot noise as a negative signal.",
        defaultValue: literal(0.05),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "ENGAGEMENT_WEIGHT_DM_BOOST",
        owner: "discord-bot",
        stage: "runtime",
        section: "engagement",
        required: false,
        secret: false,
        kind: "number",
        description: "DM score multiplier used by engagement scoring.",
        defaultValue: literal(1.5),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "ENGAGEMENT_WEIGHT_DECAY",
        owner: "discord-bot",
        stage: "runtime",
        section: "engagement",
        required: false,
        secret: false,
        kind: "number",
        description: "Time decay factor reserved for engagement scoring.",
        defaultValue: literal(0.05),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "ENGAGEMENT_IGNORE_MODE",
        owner: "discord-bot",
        stage: "runtime",
        section: "engagement",
        required: false,
        secret: false,
        kind: "enum",
        description: "How the bot acknowledges skipped engagement decisions.",
        defaultValue: literal("silent"),
        allowedValues: [
            "silent",
            "react",
        ],
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "ENGAGEMENT_REACTION_EMOJI",
        owner: "discord-bot",
        stage: "runtime",
        section: "engagement",
        required: false,
        secret: false,
        kind: "string",
        description: "Emoji reaction used when engagement ignore mode is react.",
        defaultValue: literal("👍"),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "ENGAGEMENT_MIN_THRESHOLD",
        owner: "discord-bot",
        stage: "runtime",
        section: "engagement",
        required: false,
        secret: false,
        kind: "number",
        description: "Minimum engagement score required before responding.",
        defaultValue: literal(0.5),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "ENGAGEMENT_PROBABILISTIC_LOW",
        owner: "discord-bot",
        stage: "runtime",
        section: "engagement",
        required: false,
        secret: false,
        kind: "number",
        description: "Lower bound of the LLM-refinement grey band.",
        defaultValue: literal(0.4),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "ENGAGEMENT_PROBABILISTIC_HIGH",
        owner: "discord-bot",
        stage: "runtime",
        section: "engagement",
        required: false,
        secret: false,
        kind: "number",
        description: "Upper bound of the LLM-refinement grey band.",
        defaultValue: literal(0.6),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "ENGAGEMENT_ENABLE_LLM_REFINEMENT",
        owner: "discord-bot",
        stage: "runtime",
        section: "engagement",
        required: false,
        secret: false,
        kind: "boolean",
        description: "Enables the optional engagement refinement pass.",
        defaultValue: literal(false),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "DISCORD_BOT_LOG_FULL_CONTEXT",
        owner: "discord-bot",
        stage: "runtime",
        section: "debug",
        required: false,
        secret: false,
        kind: "boolean",
        description: "Enables verbose context logging in the Discord bot.",
        defaultValue: literal(false),
        usedBy: [
            "packages/discord-bot/src/config.ts",
        ],
    }),

    defineEnv({
        key: "IMAGE_DEFAULT_TEXT_MODEL",
        owner: "discord-bot",
        stage: "runtime",
        section: "image",
        required: false,
        secret: false,
        kind: "string",
        description: "Default text model used by image prompting flows.",
        defaultValue: literal("gpt-4.1-mini"),
        usedBy: [
            "packages/discord-bot/src/config/imageConfig.ts",
        ],
    }),

    defineEnv({
        key: "IMAGE_DEFAULT_IMAGE_MODEL",
        owner: "discord-bot",
        stage: "runtime",
        section: "image",
        required: false,
        secret: false,
        kind: "string",
        description: "Default image render model.",
        defaultValue: literal("gpt-image-1-mini"),
        usedBy: [
            "packages/discord-bot/src/config/imageConfig.ts",
        ],
    }),

    defineEnv({
        key: "IMAGE_DEFAULT_QUALITY",
        owner: "discord-bot",
        stage: "runtime",
        section: "image",
        required: false,
        secret: false,
        kind: "enum",
        description: "Default image quality preset.",
        defaultValue: literal("low"),
        usedBy: [
            "packages/discord-bot/src/config/imageConfig.ts",
        ],
    }),

    defineEnv({
        key: "IMAGE_DEFAULT_OUTPUT_FORMAT",
        owner: "discord-bot",
        stage: "runtime",
        section: "image",
        required: false,
        secret: false,
        kind: "enum",
        description: "Default image output format.",
        defaultValue: literal("png"),
        allowedValues: [
            "png",
            "webp",
            "jpeg",
        ],
        usedBy: [
            "packages/discord-bot/src/config/imageConfig.ts",
        ],
    }),

    defineEnv({
        key: "IMAGE_DEFAULT_OUTPUT_COMPRESSION",
        owner: "discord-bot",
        stage: "runtime",
        section: "image",
        required: false,
        secret: false,
        kind: "integer",
        description: "Default output compression for generated images.",
        defaultValue: literal(100),
        usedBy: [
            "packages/discord-bot/src/config/imageConfig.ts",
        ],
    }),

    defineEnv({
        key: "IMAGE_TOKENS_PER_REFRESH",
        owner: "discord-bot",
        stage: "runtime",
        section: "image",
        required: false,
        secret: false,
        kind: "integer",
        description: "Token allowance granted each image refresh interval.",
        defaultValue: literal(10),
        usedBy: [
            "packages/discord-bot/src/config/imageConfig.ts",
        ],
    }),

    defineEnv({
        key: "IMAGE_TOKEN_REFRESH_INTERVAL_MS",
        owner: "discord-bot",
        stage: "runtime",
        section: "image",
        required: false,
        secret: false,
        kind: "integer",
        description: "Refresh interval for replenishing image tokens.",
        defaultValue: literal(86400000),
        usedBy: [
            "packages/discord-bot/src/config/imageConfig.ts",
        ],
    }),

    defineEnv({
        key: "IMAGE_MODEL_MULTIPLIERS",
        owner: "discord-bot",
        stage: "runtime",
        section: "image",
        required: false,
        secret: false,
        kind: "json",
        description: "JSON object with model-specific image token multipliers.",
        defaultValue: literal({
            "gpt-image-1-mini": 1,
            "gpt-image-1": 2,
            "gpt-image-1.5": 2,
        }),
        usedBy: [
            "packages/discord-bot/src/config/imageConfig.ts",
        ],
    }),

    defineEnv({
        key: "IMAGE_MODEL_MULTIPLIER_<MODEL_NAME>",
        owner: "discord-bot",
        stage: "runtime",
        section: "image",
        required: false,
        secret: false,
        kind: "number",
        description: "Per-model image multiplier override using IMAGE_MODEL_MULTIPLIER_<MODEL_NAME> naming.",
        defaultValue: noDefault(),
        notes: [
            "These override the shared IMAGE_MODEL_MULTIPLIERS map for a single model.",
        ],
        usedBy: [
            "packages/discord-bot/src/config/imageConfig.ts",
        ],
    }),

    defineEnv({
        key: "CLOUDINARY_CLOUD_NAME",
        owner: "discord-bot",
        stage: "runtime",
        section: "image",
        required: false,
        secret: false,
        kind: "string",
        description: "Cloudinary cloud name used for image uploads.",
        defaultValue: noDefault(),
        usedBy: [
            "packages/discord-bot/src/config/imageConfig.ts",
        ],
    }),

    defineEnv({
        key: "CLOUDINARY_API_KEY",
        owner: "discord-bot",
        stage: "runtime",
        section: "image",
        required: false,
        secret: true,
        kind: "string",
        description: "Cloudinary API key used for image uploads.",
        defaultValue: noDefault(),
        usedBy: [
            "packages/discord-bot/src/config/imageConfig.ts",
        ],
    }),

    defineEnv({
        key: "CLOUDINARY_API_SECRET",
        owner: "discord-bot",
        stage: "runtime",
        section: "image",
        required: false,
        secret: true,
        kind: "string",
        description: "Cloudinary API secret used for image uploads.",
        defaultValue: noDefault(),
        usedBy: [
            "packages/discord-bot/src/config/imageConfig.ts",
        ],
    }),

    defineEnv({
        key: "DATA_DIR",
        owner: "backend",
        stage: "runtime",
        section: "backend-server",
        required: false,
        secret: false,
        kind: "string",
        description: "Directory used for backend persistent data on disk.",
        defaultValue: literal("/data"),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "HOST",
        owner: "backend",
        stage: "runtime",
        section: "backend-server",
        required: false,
        secret: false,
        kind: "string",
        description: "Host/interface the backend binds to.",
        defaultValue: literal("::"),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "PORT",
        owner: "backend",
        stage: "runtime",
        section: "backend-server",
        required: false,
        secret: false,
        kind: "integer",
        description: "Port the backend listens on.",
        defaultValue: literal(3000),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "WEB_TRUST_PROXY",
        owner: "backend",
        stage: "runtime",
        section: "backend-server",
        required: false,
        secret: false,
        kind: "boolean",
        description: "Enables Express trust proxy behavior for web requests.",
        defaultValue: literal(false),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "DEFAULT_MODEL",
        owner: "backend",
        stage: "runtime",
        section: "openai",
        required: false,
        secret: false,
        kind: "string",
        description: "Default model used by backend reflect flows.",
        defaultValue: literal("gpt-5-mini"),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "DEFAULT_REASONING_EFFORT",
        owner: "backend",
        stage: "runtime",
        section: "openai",
        required: false,
        secret: false,
        kind: "string",
        description: "Default reasoning effort for backend reflect flows.",
        defaultValue: literal("low"),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "DEFAULT_VERBOSITY",
        owner: "backend",
        stage: "runtime",
        section: "openai",
        required: false,
        secret: false,
        kind: "string",
        description: "Default verbosity for backend reflect flows.",
        defaultValue: literal("low"),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "OPENAI_REQUEST_TIMEOUT_MS",
        owner: "backend",
        stage: "runtime",
        section: "openai",
        required: false,
        secret: false,
        kind: "integer",
        description: "Timeout budget for backend OpenAI requests.",
        defaultValue: literal(180000),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "ALLOWED_ORIGINS",
        owner: "backend",
        stage: "runtime",
        section: "web",
        required: false,
        secret: false,
        kind: "csv",
        description: "CORS allowlist for web origins.",
        defaultValue: literal([
            "http://localhost:8080",
            "http://localhost:3000",
            "https://ai.jordanmakes.dev",
        ]),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "REFLECT_SERVICE_TOKEN",
        owner: "backend",
        stage: "runtime",
        section: "reflect",
        required: false,
        secret: true,
        kind: "string",
        description: "Shared secret for trusted reflect callers.",
        defaultValue: noDefault(),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "REFLECT_API_MAX_BODY_BYTES",
        owner: "backend",
        stage: "runtime",
        section: "reflect",
        required: false,
        secret: false,
        kind: "integer",
        description: "Maximum request body size for /api/reflect.",
        defaultValue: literal(262144),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "TRACE_API_MAX_BODY_BYTES",
        owner: "backend",
        stage: "runtime",
        section: "trace",
        required: false,
        secret: false,
        kind: "integer",
        description: "Maximum request body size for /api/traces.",
        defaultValue: literal(262144),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "WEB_API_RATE_LIMIT_IP",
        owner: "backend",
        stage: "runtime",
        section: "rate-limits",
        required: false,
        secret: false,
        kind: "integer",
        description: "Public web API rate limit per IP.",
        defaultValue: literal(3),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "WEB_API_RATE_LIMIT_IP_WINDOW_MS",
        owner: "backend",
        stage: "runtime",
        section: "rate-limits",
        required: false,
        secret: false,
        kind: "integer",
        description: "Window for the public web API per-IP rate limit.",
        defaultValue: literal(60000),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "WEB_API_RATE_LIMIT_SESSION",
        owner: "backend",
        stage: "runtime",
        section: "rate-limits",
        required: false,
        secret: false,
        kind: "integer",
        description: "Public web API rate limit per session.",
        defaultValue: literal(5),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "WEB_API_RATE_LIMIT_SESSION_WINDOW_MS",
        owner: "backend",
        stage: "runtime",
        section: "rate-limits",
        required: false,
        secret: false,
        kind: "integer",
        description: "Window for the public web API per-session rate limit.",
        defaultValue: literal(60000),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "REFLECT_SERVICE_RATE_LIMIT",
        owner: "backend",
        stage: "runtime",
        section: "rate-limits",
        required: false,
        secret: false,
        kind: "integer",
        description: "Trusted reflect service rate limit.",
        defaultValue: literal(30),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "REFLECT_SERVICE_RATE_LIMIT_WINDOW_MS",
        owner: "backend",
        stage: "runtime",
        section: "rate-limits",
        required: false,
        secret: false,
        kind: "integer",
        description: "Window for the trusted reflect service rate limit.",
        defaultValue: literal(60000),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "TRACE_API_RATE_LIMIT",
        owner: "backend",
        stage: "runtime",
        section: "rate-limits",
        required: false,
        secret: false,
        kind: "integer",
        description: "Trace API write rate limit.",
        defaultValue: literal(10),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "TRACE_API_RATE_LIMIT_WINDOW_MS",
        owner: "backend",
        stage: "runtime",
        section: "rate-limits",
        required: false,
        secret: false,
        kind: "integer",
        description: "Window for the trace API write rate limit.",
        defaultValue: literal(60000),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "TURNSTILE_SECRET_KEY",
        owner: "backend",
        stage: "runtime",
        section: "turnstile",
        required: false,
        secret: true,
        kind: "string",
        description: "Cloudflare Turnstile secret key.",
        defaultValue: noDefault(),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "TURNSTILE_SITE_KEY",
        owner: "backend",
        stage: "runtime",
        section: "turnstile",
        required: false,
        secret: false,
        kind: "string",
        description: "Cloudflare Turnstile site key returned to the web client.",
        defaultValue: noDefault(),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "TURNSTILE_ALLOWED_HOSTNAMES",
        owner: "backend",
        stage: "runtime",
        section: "turnstile",
        required: false,
        secret: false,
        kind: "csv",
        description: "Optional allowlist of hostnames accepted in Turnstile responses.",
        defaultValue: literal([]),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "GITHUB_WEBHOOK_SECRET",
        owner: "backend",
        stage: "runtime",
        section: "webhooks",
        required: false,
        secret: true,
        kind: "string",
        description: "GitHub webhook signing secret.",
        defaultValue: noDefault(),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "GITHUB_WEBHOOK_REPOSITORY",
        owner: "backend",
        stage: "runtime",
        section: "webhooks",
        required: false,
        secret: false,
        kind: "string",
        description: "GitHub repository accepted by the webhook handler.",
        defaultValue: literal("footnote-ai/footnote"),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "GITHUB_WEBHOOK_MAX_BODY_BYTES",
        owner: "backend",
        stage: "runtime",
        section: "webhooks",
        required: false,
        secret: false,
        kind: "integer",
        description: "Maximum request body size for the GitHub webhook endpoint.",
        defaultValue: literal(262144),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "PROVENANCE_SQLITE_PATH",
        owner: "backend",
        stage: "runtime",
        section: "storage",
        required: false,
        secret: false,
        kind: "string",
        description: "SQLite path for provenance trace storage.",
        defaultValue: noDefault(),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),

    defineEnv({
        key: "INCIDENT_SQLITE_PATH",
        owner: "backend",
        stage: "runtime",
        section: "storage",
        required: false,
        secret: false,
        kind: "string",
        description: "SQLite path for incident storage.",
        defaultValue: noDefault(),
        usedBy: [
            "packages/backend/src/config.ts",
        ],
    }),
] as const satisfies readonly EnvSpecEntry[];

// Keep the ordered list export because it is the easiest form to browse in docs
// and tooling when someone wants to scan the full environment surface.
export const envSpec = envEntries;

type EnvEntries = typeof envEntries;

type EnvSpecByKey = {
    [Entry in EnvEntries[number] as Entry['key']]: Entry;
};

// Handy lookup for scripts, docs, and future tooling that want one env key at
// a time without manually searching the full ordered list above.
export const envSpecByKey = Object.fromEntries(
    envEntries.map((entry) => [entry.key, entry])
) as EnvSpecByKey;

// Only literal env-backed defaults belong here. Derived/runtime fallbacks stay
// in runtimeFallbacks so operators can clearly tell which values come from env.
export const envDefaultValues = {
    LOG_DIR: envSpecByKey.LOG_DIR.defaultValue.value,
    LOG_LEVEL: envSpecByKey.LOG_LEVEL.defaultValue.value,
    NODE_ENV: envSpecByKey.NODE_ENV.defaultValue.value,
    FRAME_ANCESTORS: envSpecByKey.FRAME_ANCESTORS.defaultValue.value,
    BACKEND_REQUEST_TIMEOUT_MS: envSpecByKey.BACKEND_REQUEST_TIMEOUT_MS.defaultValue.value,
    WEBHOOK_PORT: envSpecByKey.WEBHOOK_PORT.defaultValue.value,
    RATE_LIMIT_USER: envSpecByKey.RATE_LIMIT_USER.defaultValue.value,
    USER_RATE_LIMIT: envSpecByKey.USER_RATE_LIMIT.defaultValue.value,
    USER_RATE_WINDOW_MS: envSpecByKey.USER_RATE_WINDOW_MS.defaultValue.value,
    RATE_LIMIT_CHANNEL: envSpecByKey.RATE_LIMIT_CHANNEL.defaultValue.value,
    CHANNEL_RATE_LIMIT: envSpecByKey.CHANNEL_RATE_LIMIT.defaultValue.value,
    CHANNEL_RATE_WINDOW_MS: envSpecByKey.CHANNEL_RATE_WINDOW_MS.defaultValue.value,
    RATE_LIMIT_GUILD: envSpecByKey.RATE_LIMIT_GUILD.defaultValue.value,
    GUILD_RATE_LIMIT: envSpecByKey.GUILD_RATE_LIMIT.defaultValue.value,
    GUILD_RATE_WINDOW_MS: envSpecByKey.GUILD_RATE_WINDOW_MS.defaultValue.value,
    ALLOW_THREAD_RESPONSES: envSpecByKey.ALLOW_THREAD_RESPONSES.defaultValue.value,
    ALLOWED_THREAD_IDS: envSpecByKey.ALLOWED_THREAD_IDS.defaultValue.value,
    BOT_MENTION_NAMES: envSpecByKey.BOT_MENTION_NAMES.defaultValue.value,
    BOT_BACK_AND_FORTH_LIMIT: envSpecByKey.BOT_BACK_AND_FORTH_LIMIT.defaultValue.value,
    BOT_BACK_AND_FORTH_COOLDOWN_MS: envSpecByKey.BOT_BACK_AND_FORTH_COOLDOWN_MS.defaultValue.value,
    BOT_BACK_AND_FORTH_TTL_MS: envSpecByKey.BOT_BACK_AND_FORTH_TTL_MS.defaultValue.value,
    BOT_BACK_AND_FORTH_ACTION: envSpecByKey.BOT_BACK_AND_FORTH_ACTION.defaultValue.value,
    BOT_BACK_AND_FORTH_REACTION: envSpecByKey.BOT_BACK_AND_FORTH_REACTION.defaultValue.value,
    CATCHUP_AFTER_MESSAGES: envSpecByKey.CATCHUP_AFTER_MESSAGES.defaultValue.value,
    CATCHUP_IF_MENTIONED_AFTER_MESSAGES: envSpecByKey.CATCHUP_IF_MENTIONED_AFTER_MESSAGES.defaultValue.value,
    STALE_COUNTER_TTL_MS: envSpecByKey.STALE_COUNTER_TTL_MS.defaultValue.value,
    CONTEXT_MANAGER_ENABLED: envSpecByKey.CONTEXT_MANAGER_ENABLED.defaultValue.value,
    CONTEXT_MANAGER_MAX_MESSAGES: envSpecByKey.CONTEXT_MANAGER_MAX_MESSAGES.defaultValue.value,
    CONTEXT_MANAGER_RETENTION_MS: envSpecByKey.CONTEXT_MANAGER_RETENTION_MS.defaultValue.value,
    CONTEXT_MANAGER_EVICTION_INTERVAL_MS: envSpecByKey.CONTEXT_MANAGER_EVICTION_INTERVAL_MS.defaultValue.value,
    COST_ESTIMATOR_ENABLED: envSpecByKey.COST_ESTIMATOR_ENABLED.defaultValue.value,
    REALTIME_FILTER_ENABLED: envSpecByKey.REALTIME_FILTER_ENABLED.defaultValue.value,
    ENGAGEMENT_WEIGHT_MENTION: envSpecByKey.ENGAGEMENT_WEIGHT_MENTION.defaultValue.value,
    ENGAGEMENT_WEIGHT_QUESTION: envSpecByKey.ENGAGEMENT_WEIGHT_QUESTION.defaultValue.value,
    ENGAGEMENT_WEIGHT_TECHNICAL: envSpecByKey.ENGAGEMENT_WEIGHT_TECHNICAL.defaultValue.value,
    ENGAGEMENT_WEIGHT_HUMAN_ACTIVITY: envSpecByKey.ENGAGEMENT_WEIGHT_HUMAN_ACTIVITY.defaultValue.value,
    ENGAGEMENT_WEIGHT_COST_SATURATION: envSpecByKey.ENGAGEMENT_WEIGHT_COST_SATURATION.defaultValue.value,
    ENGAGEMENT_WEIGHT_BOT_NOISE: envSpecByKey.ENGAGEMENT_WEIGHT_BOT_NOISE.defaultValue.value,
    ENGAGEMENT_WEIGHT_DM_BOOST: envSpecByKey.ENGAGEMENT_WEIGHT_DM_BOOST.defaultValue.value,
    ENGAGEMENT_WEIGHT_DECAY: envSpecByKey.ENGAGEMENT_WEIGHT_DECAY.defaultValue.value,
    ENGAGEMENT_IGNORE_MODE: envSpecByKey.ENGAGEMENT_IGNORE_MODE.defaultValue.value,
    ENGAGEMENT_REACTION_EMOJI: envSpecByKey.ENGAGEMENT_REACTION_EMOJI.defaultValue.value,
    ENGAGEMENT_MIN_THRESHOLD: envSpecByKey.ENGAGEMENT_MIN_THRESHOLD.defaultValue.value,
    ENGAGEMENT_PROBABILISTIC_LOW: envSpecByKey.ENGAGEMENT_PROBABILISTIC_LOW.defaultValue.value,
    ENGAGEMENT_PROBABILISTIC_HIGH: envSpecByKey.ENGAGEMENT_PROBABILISTIC_HIGH.defaultValue.value,
    ENGAGEMENT_ENABLE_LLM_REFINEMENT: envSpecByKey.ENGAGEMENT_ENABLE_LLM_REFINEMENT.defaultValue.value,
    DISCORD_BOT_LOG_FULL_CONTEXT: envSpecByKey.DISCORD_BOT_LOG_FULL_CONTEXT.defaultValue.value,
    IMAGE_DEFAULT_TEXT_MODEL: envSpecByKey.IMAGE_DEFAULT_TEXT_MODEL.defaultValue.value,
    IMAGE_DEFAULT_IMAGE_MODEL: envSpecByKey.IMAGE_DEFAULT_IMAGE_MODEL.defaultValue.value,
    IMAGE_DEFAULT_QUALITY: envSpecByKey.IMAGE_DEFAULT_QUALITY.defaultValue.value,
    IMAGE_DEFAULT_OUTPUT_FORMAT: envSpecByKey.IMAGE_DEFAULT_OUTPUT_FORMAT.defaultValue.value,
    IMAGE_DEFAULT_OUTPUT_COMPRESSION: envSpecByKey.IMAGE_DEFAULT_OUTPUT_COMPRESSION.defaultValue.value,
    IMAGE_TOKENS_PER_REFRESH: envSpecByKey.IMAGE_TOKENS_PER_REFRESH.defaultValue.value,
    IMAGE_TOKEN_REFRESH_INTERVAL_MS: envSpecByKey.IMAGE_TOKEN_REFRESH_INTERVAL_MS.defaultValue.value,
    IMAGE_MODEL_MULTIPLIERS: envSpecByKey.IMAGE_MODEL_MULTIPLIERS.defaultValue.value,
    DATA_DIR: envSpecByKey.DATA_DIR.defaultValue.value,
    HOST: envSpecByKey.HOST.defaultValue.value,
    PORT: envSpecByKey.PORT.defaultValue.value,
    WEB_TRUST_PROXY: envSpecByKey.WEB_TRUST_PROXY.defaultValue.value,
    DEFAULT_MODEL: envSpecByKey.DEFAULT_MODEL.defaultValue.value,
    DEFAULT_REASONING_EFFORT: envSpecByKey.DEFAULT_REASONING_EFFORT.defaultValue.value,
    DEFAULT_VERBOSITY: envSpecByKey.DEFAULT_VERBOSITY.defaultValue.value,
    OPENAI_REQUEST_TIMEOUT_MS: envSpecByKey.OPENAI_REQUEST_TIMEOUT_MS.defaultValue.value,
    ALLOWED_ORIGINS: envSpecByKey.ALLOWED_ORIGINS.defaultValue.value,
    REFLECT_API_MAX_BODY_BYTES: envSpecByKey.REFLECT_API_MAX_BODY_BYTES.defaultValue.value,
    TRACE_API_MAX_BODY_BYTES: envSpecByKey.TRACE_API_MAX_BODY_BYTES.defaultValue.value,
    WEB_API_RATE_LIMIT_IP: envSpecByKey.WEB_API_RATE_LIMIT_IP.defaultValue.value,
    WEB_API_RATE_LIMIT_IP_WINDOW_MS: envSpecByKey.WEB_API_RATE_LIMIT_IP_WINDOW_MS.defaultValue.value,
    WEB_API_RATE_LIMIT_SESSION: envSpecByKey.WEB_API_RATE_LIMIT_SESSION.defaultValue.value,
    WEB_API_RATE_LIMIT_SESSION_WINDOW_MS: envSpecByKey.WEB_API_RATE_LIMIT_SESSION_WINDOW_MS.defaultValue.value,
    REFLECT_SERVICE_RATE_LIMIT: envSpecByKey.REFLECT_SERVICE_RATE_LIMIT.defaultValue.value,
    REFLECT_SERVICE_RATE_LIMIT_WINDOW_MS: envSpecByKey.REFLECT_SERVICE_RATE_LIMIT_WINDOW_MS.defaultValue.value,
    TRACE_API_RATE_LIMIT: envSpecByKey.TRACE_API_RATE_LIMIT.defaultValue.value,
    TRACE_API_RATE_LIMIT_WINDOW_MS: envSpecByKey.TRACE_API_RATE_LIMIT_WINDOW_MS.defaultValue.value,
    TURNSTILE_ALLOWED_HOSTNAMES: envSpecByKey.TURNSTILE_ALLOWED_HOSTNAMES.defaultValue.value,
    GITHUB_WEBHOOK_REPOSITORY: envSpecByKey.GITHUB_WEBHOOK_REPOSITORY.defaultValue.value,
    GITHUB_WEBHOOK_MAX_BODY_BYTES: envSpecByKey.GITHUB_WEBHOOK_MAX_BODY_BYTES.defaultValue.value,
} as const;

export { runtimeFallbacks };
