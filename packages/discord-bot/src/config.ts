/**
 * @description: Loads and validates Discord bot environment configuration and defaults.
 * @footnote-scope: utility
 * @footnote-module: EnvConfig
 * @footnote-risk: high - Misconfiguration can break auth, rate limits, or cost tracking.
 * @footnote-ethics: medium - Incorrect settings can alter safety behavior or disclosure.
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    envDefaultValues,
    envSpecByKey,
} from '@footnote/config-spec';
import type {
    SupportedBotInteractionAction,
    SupportedEngagementIgnoreMode,
} from '@footnote/contracts/providers';
import { bootstrapLogger } from './utils/logger.js';
import {
    PromptRegistry,
    renderPrompt as sharedRenderPrompt,
    setActivePromptRegistry,
    type PromptKey,
} from './utils/prompts/promptRegistry.js';

// Get the current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Calculate .env file path
const envPath = path.resolve(__dirname, '../../../.env');
bootstrapLogger.debug(`Loading environment variables from: ${envPath}`);

// Load environment variables from .env file in the root directory (when present).
if (fs.existsSync(envPath)) {
    const { error, parsed } = dotenv.config({ path: envPath });

    if (error) {
        bootstrapLogger.warn(`Failed to load .env file: ${error.message}`);
    } else if (parsed) {
        bootstrapLogger.debug(
            `Loaded environment variables: ${Object.keys(parsed).join(', ')}`
        );
    }
} else {
    bootstrapLogger.debug(
        'No .env file found; relying on injected environment variables.'
    );
}

/**
 * List of required environment variables that must be set for the application to run.
 * @type {readonly string[]}
 */
const REQUIRED_ENV_VARS: readonly string[] = [
    'DISCORD_TOKEN', // Discord bot token for authentication
    'DISCORD_CLIENT_ID', // Discord application client ID
    'DISCORD_GUILD_ID', // Discord server (guild) ID
    'OPENAI_API_KEY', // OpenAI API key for AI functionality
    'DISCORD_USER_ID', // Discord user ID of the developer for privileged access
    'INCIDENT_PSEUDONYMIZATION_SECRET', // Secret key for HMAC pseudonymization of Discord IDs
] as const;

const DEFAULT_RUNTIME_NODE_ENV = envDefaultValues.NODE_ENV;
const DEFAULT_LOG_DIRECTORY = envDefaultValues.LOG_DIR;
const DEFAULT_LOG_LEVEL = envDefaultValues.LOG_LEVEL;

/**
 * Validates that all required environment variables are set.
 * @throws {Error} If any required environment variable is missing
 */
function validateEnvironment() {
    for (const envVar of REQUIRED_ENV_VARS) {
        if (!process.env[envVar]) {
            throw new Error(`Missing required environment variable: ${envVar}`);
        }
    }

    // Log set rate limits
    bootstrapLogger.debug(
        `Rate limits: ${JSON.stringify({
            user: {
                enabled: envDefaultValues.RATE_LIMIT_USER,
                limit: envDefaultValues.USER_RATE_LIMIT,
                windowMs: envDefaultValues.USER_RATE_WINDOW_MS,
            },
            channel: {
                enabled: envDefaultValues.RATE_LIMIT_CHANNEL,
                limit: envDefaultValues.CHANNEL_RATE_LIMIT,
                windowMs: envDefaultValues.CHANNEL_RATE_WINDOW_MS,
            },
            guild: {
                enabled: envDefaultValues.RATE_LIMIT_GUILD,
                limit: envDefaultValues.GUILD_RATE_LIMIT,
                windowMs: envDefaultValues.GUILD_RATE_WINDOW_MS,
            },
        })}`
    );
}

// Validate environment variables on startup
validateEnvironment();

// Resolve the optional prompt override configuration path.
// Allows pointing to a custom YAML file to tweak the bot's behavior.
const rawPromptConfigPath = process.env.PROMPT_CONFIG_PATH;
const promptConfigPath = rawPromptConfigPath
    ? path.isAbsolute(rawPromptConfigPath)
        ? rawPromptConfigPath
        : path.resolve(__dirname, '../../../', rawPromptConfigPath)
    : undefined;

if (promptConfigPath) {
    bootstrapLogger.info(
        `Loading prompt overrides from: ${promptConfigPath}`
    );
}

const flyAppName = process.env.FLY_APP_NAME?.trim();
const FLY_INTERNAL_BACKEND_BASE_URL = 'http://footnote-backend.internal:3000';
// Default to the Fly-provisioned hostname when present so deployments work without extra config.
const fallbackWebBaseUrl = flyAppName
    ? `https://${flyAppName}.fly.dev`
    : undefined;
const rawWebBaseUrl = process.env.WEB_BASE_URL?.trim();
const fallbackLocalBaseUrl =
    envSpecByKey.WEB_BASE_URL.defaultValue.kind === 'derived' &&
    typeof envSpecByKey.WEB_BASE_URL.defaultValue.fallbackValue === 'string'
        ? envSpecByKey.WEB_BASE_URL.defaultValue.fallbackValue
        : 'http://localhost:8080';
const webBaseUrl =
    rawWebBaseUrl && rawWebBaseUrl.length > 0
        ? rawWebBaseUrl
        : fallbackWebBaseUrl || fallbackLocalBaseUrl;

if (!webBaseUrl) {
    throw new Error(
        'Missing WEB_BASE_URL. Set WEB_BASE_URL explicitly or deploy via Fly.io so FLY_APP_NAME provides the default.'
    );
}
bootstrapLogger.info(`Using web base URL: ${webBaseUrl}`);

const rawBackendBaseUrl = process.env.BACKEND_BASE_URL?.trim();
const fallbackBackendBaseUrl = flyAppName
    ? FLY_INTERNAL_BACKEND_BASE_URL
    : envSpecByKey.BACKEND_BASE_URL.defaultValue.kind === 'derived'
      ? typeof envSpecByKey.BACKEND_BASE_URL.defaultValue.fallbackValue ===
            'string'
          ? envSpecByKey.BACKEND_BASE_URL.defaultValue.fallbackValue
          : 'http://localhost:3000'
      : 'http://localhost:3000';
const backendBaseUrl =
    rawBackendBaseUrl && rawBackendBaseUrl.length > 0
        ? rawBackendBaseUrl.replace(/\/+$/, '')
        : fallbackBackendBaseUrl;

bootstrapLogger.info(`Using backend base URL: ${backendBaseUrl}`);
const traceApiToken = process.env.TRACE_API_TOKEN?.trim();
const nodeEnv = process.env.NODE_ENV || DEFAULT_RUNTIME_NODE_ENV;
const isProduction = nodeEnv === 'production';

// Instantiate the shared prompt registry and expose it to downstream modules.
export const promptRegistry = new PromptRegistry({
    overridePath: promptConfigPath,
});
setActivePromptRegistry(promptRegistry);

// Ensure every prompt required by the bot is present at startup. This catches
// missing keys in overrides before the first request makes it to OpenAI.
const REQUIRED_PROMPT_KEYS: PromptKey[] = [
    'discord.chat.system',
    'discord.image.system',
    'discord.image.developer',
    'discord.news.system',
    'discord.planner.system',
    'discord.realtime.system',
    'discord.summarizer.system',
];

promptRegistry.assertKeys(REQUIRED_PROMPT_KEYS);

export const renderPrompt = sharedRenderPrompt;

/**
 * Reads a numeric configuration value while gracefully handling invalid input
 */
function getNumberEnv(key: string, defaultValue: number): number {
    const value = process.env[key];
    if (value === undefined) {
        return defaultValue;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        bootstrapLogger.warn(
            `Ignoring invalid numeric value for ${key}: "${value}". Expected a non-negative number; using default (${defaultValue}).`
        );
        return defaultValue;
    }

    return parsed;
}

/**
 * Gets a boolean from environment variables with a default value
 */
function getBooleanEnv(key: string, defaultValue: boolean): boolean {
    const value = process.env[key];
    if (value === undefined) return defaultValue;
    return value.toLowerCase() === 'true';
}

/**
 * Parses a comma-delimited list from the environment into an array of strings.
 *
 * Discord channel/thread identifiers are strings that may contain leading
 * zeroes, so we avoid coercing to numbers. Empty or whitespace-only entries are
 * discarded to protect against configuration mistakes such as stray commas.
 */
function getStringArrayEnv(
    key: string,
    defaultValue: readonly string[]
): string[] {
    const value = process.env[key];
    if (!value) {
        return [...defaultValue];
    }

    const entries = value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    if (entries.length === 0) {
        bootstrapLogger.warn(
            `Ignoring ${key} because it did not contain any valid thread identifiers. Falling back to default (${defaultValue.join(', ') || 'none'}).`
        );
        return [...defaultValue];
    }

    return entries;
}

/**
 * Reads the preferred action to take once the bot-to-bot conversation limit is reached
 */
function getBotInteractionActionEnv(
    key: string,
    defaultValue: SupportedBotInteractionAction
): SupportedBotInteractionAction {
    const value = process.env[key];
    if (!value) return defaultValue;

    const normalized = value.trim().toLowerCase();
    if (normalized === 'ignore' || normalized === 'react') {
        return normalized;
    }

    bootstrapLogger.warn(
        `Ignoring invalid bot interaction action for ${key}: "${value}". Expected "ignore" or "react"; using default (${defaultValue}).`
    );

    return defaultValue;
}

/**
 * Reads the preferred engagement ignore mode when the realtime filter skips
 */
function getEngagementIgnoreModeEnv(
    key: string,
    defaultValue: SupportedEngagementIgnoreMode
): SupportedEngagementIgnoreMode {
    const value = process.env[key];
    if (!value) return defaultValue;

    const normalized = value.trim().toLowerCase();
    if (normalized === 'silent' || normalized === 'react') {
        return normalized;
    }

    bootstrapLogger.warn(
        `Ignoring invalid engagement ignore mode for ${key}: "${value}". Expected "silent" or "react"; using default (${defaultValue}).`
    );

    return defaultValue;
}

/**
 * Application configuration object containing all environment-based settings.
 * @type {Object}
 * @property {string} token - Discord bot token
 * @property {string} clientId - Discord application client ID
 * @property {string} guildId - Discord server (guild) ID
 * @property {string} openaiApiKey - OpenAI API key
 * @property {string|undefined} env - Current environment (e.g., 'development', 'production')
 * @property {boolean} isProduction - Whether the current environment is production
 * @property {Object} rateLimits - Rate limiting configuration
 */
export const runtimeConfig = {
    // Bot configuration
    token: process.env.DISCORD_TOKEN!,
    clientId: process.env.DISCORD_CLIENT_ID!,
    guildId: process.env.DISCORD_GUILD_ID!,
    openaiApiKey: process.env.OPENAI_API_KEY!,
    developerUserId: process.env.DISCORD_USER_ID!,
    incidentPseudonymizationSecret:
        process.env.INCIDENT_PSEUDONYMIZATION_SECRET!,
    promptConfigPath,
    webBaseUrl,
    backendBaseUrl,
    traceApiToken,
    webhookPort: getNumberEnv('WEBHOOK_PORT', envDefaultValues.WEBHOOK_PORT),
    api: {
        backendRequestTimeoutMs: getNumberEnv(
            'BACKEND_REQUEST_TIMEOUT_MS',
            envDefaultValues.BACKEND_REQUEST_TIMEOUT_MS
        ),
    },

    // Bot mention names for engagement detection
    botMentionNames: getStringArrayEnv(
        'BOT_MENTION_NAMES',
        envDefaultValues.BOT_MENTION_NAMES
    ),

    // Environment
    env: nodeEnv,
    isProduction,
    isDevelopment: !isProduction,

    // Rate limiting configuration
    rateLimits: {
        user: {
            enabled: getBooleanEnv(
                'RATE_LIMIT_USER',
                envDefaultValues.RATE_LIMIT_USER
            ),
            limit: getNumberEnv(
                'USER_RATE_LIMIT',
                envDefaultValues.USER_RATE_LIMIT
            ),
            windowMs: getNumberEnv(
                'USER_RATE_WINDOW_MS',
                envDefaultValues.USER_RATE_WINDOW_MS
            ),
        },
        channel: {
            enabled: getBooleanEnv(
                'RATE_LIMIT_CHANNEL',
                envDefaultValues.RATE_LIMIT_CHANNEL
            ),
            limit: getNumberEnv(
                'CHANNEL_RATE_LIMIT',
                envDefaultValues.CHANNEL_RATE_LIMIT
            ),
            windowMs: getNumberEnv(
                'CHANNEL_RATE_WINDOW_MS',
                envDefaultValues.CHANNEL_RATE_WINDOW_MS
            ),
        },
        guild: {
            enabled: getBooleanEnv(
                'RATE_LIMIT_GUILD',
                envDefaultValues.RATE_LIMIT_GUILD
            ),
            limit: getNumberEnv(
                'GUILD_RATE_LIMIT',
                envDefaultValues.GUILD_RATE_LIMIT
            ),
            windowMs: getNumberEnv(
                'GUILD_RATE_WINDOW_MS',
                envDefaultValues.GUILD_RATE_WINDOW_MS
            ),
        },
    },

    // Behavioural controls to prevent getting stuck in endless loops with other bots
    botInteraction: {
        maxBackAndForth: getNumberEnv(
            'BOT_BACK_AND_FORTH_LIMIT',
            envDefaultValues.BOT_BACK_AND_FORTH_LIMIT
        ),
        cooldownMs: getNumberEnv(
            'BOT_BACK_AND_FORTH_COOLDOWN_MS',
            envDefaultValues.BOT_BACK_AND_FORTH_COOLDOWN_MS
        ),
        conversationTtlMs: getNumberEnv(
            'BOT_BACK_AND_FORTH_TTL_MS',
            envDefaultValues.BOT_BACK_AND_FORTH_TTL_MS
        ),
        afterLimitAction: getBotInteractionActionEnv(
            'BOT_BACK_AND_FORTH_ACTION',
            envDefaultValues.BOT_BACK_AND_FORTH_ACTION
        ),
        reactionEmoji:
            process.env.BOT_BACK_AND_FORTH_REACTION?.trim() ||
            envDefaultValues.BOT_BACK_AND_FORTH_REACTION,
    },

    // Message catch-up tuning
    catchUp: {
        afterMessages: getNumberEnv(
            'CATCHUP_AFTER_MESSAGES',
            envDefaultValues.CATCHUP_AFTER_MESSAGES
        ),
        ifMentionedAfterMessages: getNumberEnv(
            'CATCHUP_IF_MENTIONED_AFTER_MESSAGES',
            envDefaultValues.CATCHUP_IF_MENTIONED_AFTER_MESSAGES
        ),
        staleCounterTtlMs: getNumberEnv(
            'STALE_COUNTER_TTL_MS',
            envDefaultValues.STALE_COUNTER_TTL_MS
        ),
    },

    // Channel/thread visibility controls
    visibility: {
        allowThreadResponses: getBooleanEnv(
            'ALLOW_THREAD_RESPONSES',
            envDefaultValues.ALLOW_THREAD_RESPONSES
        ),
        allowedThreadIds: getStringArrayEnv(
            'ALLOWED_THREAD_IDS',
            envDefaultValues.ALLOWED_THREAD_IDS
        ),
    },

    // Channel context manager configuration
    contextManager: {
        enabled: getBooleanEnv(
            'CONTEXT_MANAGER_ENABLED',
            envDefaultValues.CONTEXT_MANAGER_ENABLED
        ),
        maxMessagesPerChannel: getNumberEnv(
            'CONTEXT_MANAGER_MAX_MESSAGES',
            envDefaultValues.CONTEXT_MANAGER_MAX_MESSAGES
        ),
        messageRetentionMs: getNumberEnv(
            'CONTEXT_MANAGER_RETENTION_MS',
            envDefaultValues.CONTEXT_MANAGER_RETENTION_MS
        ),
        evictionIntervalMs: getNumberEnv(
            'CONTEXT_MANAGER_EVICTION_INTERVAL_MS',
            envDefaultValues.CONTEXT_MANAGER_EVICTION_INTERVAL_MS
        ),
    },

    // Cost estimator configuration
    costEstimator: {
        enabled: getBooleanEnv(
            'COST_ESTIMATOR_ENABLED',
            envDefaultValues.COST_ESTIMATOR_ENABLED
        ),
    },

    // Realtime engagement filter configuration
    realtimeFilter: {
        enabled: getBooleanEnv(
            'REALTIME_FILTER_ENABLED',
            envDefaultValues.REALTIME_FILTER_ENABLED
        ),
    },

    // Engagement scoring weights
    engagementWeights: {
        mention: getNumberEnv(
            'ENGAGEMENT_WEIGHT_MENTION',
            envDefaultValues.ENGAGEMENT_WEIGHT_MENTION
        ),
        question: getNumberEnv(
            'ENGAGEMENT_WEIGHT_QUESTION',
            envDefaultValues.ENGAGEMENT_WEIGHT_QUESTION
        ),
        technical: getNumberEnv(
            'ENGAGEMENT_WEIGHT_TECHNICAL',
            envDefaultValues.ENGAGEMENT_WEIGHT_TECHNICAL
        ),
        humanActivity: getNumberEnv(
            'ENGAGEMENT_WEIGHT_HUMAN_ACTIVITY',
            envDefaultValues.ENGAGEMENT_WEIGHT_HUMAN_ACTIVITY
        ),
        costSaturation: getNumberEnv(
            'ENGAGEMENT_WEIGHT_COST_SATURATION',
            envDefaultValues.ENGAGEMENT_WEIGHT_COST_SATURATION
        ),
        botNoise: getNumberEnv(
            'ENGAGEMENT_WEIGHT_BOT_NOISE',
            envDefaultValues.ENGAGEMENT_WEIGHT_BOT_NOISE
        ),
        dmBoost: getNumberEnv(
            'ENGAGEMENT_WEIGHT_DM_BOOST',
            envDefaultValues.ENGAGEMENT_WEIGHT_DM_BOOST
        ),
        decay: getNumberEnv(
            'ENGAGEMENT_WEIGHT_DECAY',
            envDefaultValues.ENGAGEMENT_WEIGHT_DECAY
        ),
    },

    // Engagement behavior preferences
    engagementPreferences: {
        ignoreMode: getEngagementIgnoreModeEnv(
            'ENGAGEMENT_IGNORE_MODE',
            envDefaultValues.ENGAGEMENT_IGNORE_MODE
        ),
        reactionEmoji:
            process.env.ENGAGEMENT_REACTION_EMOJI?.trim() ||
            envDefaultValues.ENGAGEMENT_REACTION_EMOJI,
        minEngageThreshold: getNumberEnv(
            'ENGAGEMENT_MIN_THRESHOLD',
            envDefaultValues.ENGAGEMENT_MIN_THRESHOLD
        ),
        probabilisticBand: [
            getNumberEnv(
                'ENGAGEMENT_PROBABILISTIC_LOW',
                envDefaultValues.ENGAGEMENT_PROBABILISTIC_LOW
            ),
            getNumberEnv(
                'ENGAGEMENT_PROBABILISTIC_HIGH',
                envDefaultValues.ENGAGEMENT_PROBABILISTIC_HIGH
            ),
        ] as [number, number],
        enableLLMRefinement: getBooleanEnv(
            'ENGAGEMENT_ENABLE_LLM_REFINEMENT',
            envDefaultValues.ENGAGEMENT_ENABLE_LLM_REFINEMENT
        ),
    },
    logging: {
        directory: process.env.LOG_DIR || DEFAULT_LOG_DIRECTORY,
        level: (process.env.LOG_LEVEL || DEFAULT_LOG_LEVEL).toLowerCase(),
    },
    debug: {
        verboseContextLoggingEnabled: getBooleanEnv(
            'DISCORD_BOT_LOG_FULL_CONTEXT',
            envDefaultValues.DISCORD_BOT_LOG_FULL_CONTEXT
        ),
    },
} as const;
