/**
 * @description: Reads and validates Discord bot runtime configuration from environment variables.
 * @footnote-scope: utility
 * @footnote-module: RuntimeConfig
 * @footnote-risk: high - Misconfiguration can break auth, rate limits, or backend communication.
 * @footnote-ethics: medium - Incorrect defaults can change safety and disclosure behavior.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { envDefaultValues, envSpecByKey } from '@footnote/config-spec';
import type {
    SupportedBotInteractionAction,
    SupportedEngagementIgnoreMode,
} from '@footnote/contracts/providers';
import { bootstrapLogger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../../../');

const REQUIRED_ENV_VARS = [
    'DISCORD_TOKEN',
    'DISCORD_CLIENT_ID',
    'DISCORD_GUILD_ID',
    'OPENAI_API_KEY',
    'DISCORD_USER_ID',
    'INCIDENT_PSEUDONYMIZATION_SECRET',
] as const;

const DEFAULT_RUNTIME_NODE_ENV = envDefaultValues.NODE_ENV;
const DEFAULT_LOG_DIRECTORY = envDefaultValues.LOG_DIR;
const DEFAULT_LOG_LEVEL = envDefaultValues.LOG_LEVEL;
const DEFAULT_LOCAL_WEB_BASE_URL = 'http://localhost:8080';
const DEFAULT_LOCAL_BACKEND_BASE_URL = 'http://localhost:3000';
const FLY_INTERNAL_BACKEND_BASE_URL = 'http://footnote-backend.internal:3000';

const BOT_INTERACTION_ACTIONS = new Set<SupportedBotInteractionAction>(
    (envSpecByKey.BOT_BACK_AND_FORTH_ACTION.allowedValues ??
        []) as readonly SupportedBotInteractionAction[]
);
const ENGAGEMENT_IGNORE_MODES = new Set<SupportedEngagementIgnoreMode>(
    (envSpecByKey.ENGAGEMENT_IGNORE_MODE.allowedValues ??
        []) as readonly SupportedEngagementIgnoreMode[]
);

const validateEnvironment = () => {
    for (const envVar of REQUIRED_ENV_VARS) {
        if (!process.env[envVar]) {
            throw new Error(`Missing required environment variable: ${envVar}`);
        }
    }

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
};

const getNumberEnv = (key: string, defaultValue: number): number => {
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
};

const getBooleanEnv = (key: string, defaultValue: boolean): boolean => {
    const value = process.env[key];
    if (value === undefined) {
        return defaultValue;
    }

    return value.toLowerCase() === 'true';
};

const getStringArrayEnv = (
    key: string,
    defaultValue: readonly string[]
): string[] => {
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
            `Ignoring ${key} because it did not contain any valid identifiers. Falling back to default (${defaultValue.join(', ') || 'none'}).`
        );
        return [...defaultValue];
    }

    return entries;
};

const getBotInteractionActionEnv = (
    key: string,
    defaultValue: SupportedBotInteractionAction
): SupportedBotInteractionAction => {
    const value = process.env[key];
    if (!value) {
        return defaultValue;
    }

    const normalized = value.trim().toLowerCase() as SupportedBotInteractionAction;
    if (BOT_INTERACTION_ACTIONS.has(normalized)) {
        return normalized;
    }

    bootstrapLogger.warn(
        `Ignoring invalid bot interaction action for ${key}: "${value}". Expected ${[...BOT_INTERACTION_ACTIONS].join(' or ')}; using default (${defaultValue}).`
    );
    return defaultValue;
};

const getEngagementIgnoreModeEnv = (
    key: string,
    defaultValue: SupportedEngagementIgnoreMode
): SupportedEngagementIgnoreMode => {
    const value = process.env[key];
    if (!value) {
        return defaultValue;
    }

    const normalized = value.trim().toLowerCase() as SupportedEngagementIgnoreMode;
    if (ENGAGEMENT_IGNORE_MODES.has(normalized)) {
        return normalized;
    }

    bootstrapLogger.warn(
        `Ignoring invalid engagement ignore mode for ${key}: "${value}". Expected ${[...ENGAGEMENT_IGNORE_MODES].join(' or ')}; using default (${defaultValue}).`
    );
    return defaultValue;
};

validateEnvironment();

const rawPromptConfigPath = process.env.PROMPT_CONFIG_PATH;
export const promptConfigPath = rawPromptConfigPath
    ? path.isAbsolute(rawPromptConfigPath)
        ? rawPromptConfigPath
        : path.resolve(projectRoot, rawPromptConfigPath)
    : undefined;

if (promptConfigPath) {
    bootstrapLogger.info(`Loading prompt overrides from: ${promptConfigPath}`);
}

const flyAppName = process.env.FLY_APP_NAME?.trim();
const fallbackWebBaseUrl = flyAppName
    ? `https://${flyAppName}.fly.dev`
    : DEFAULT_LOCAL_WEB_BASE_URL;
const rawWebBaseUrl = process.env.WEB_BASE_URL?.trim();
const webBaseUrl =
    rawWebBaseUrl && rawWebBaseUrl.length > 0
        ? rawWebBaseUrl
        : fallbackWebBaseUrl;

bootstrapLogger.info(`Using web base URL: ${webBaseUrl}`);

const rawBackendBaseUrl = process.env.BACKEND_BASE_URL?.trim();
const fallbackBackendBaseUrl = flyAppName
    ? FLY_INTERNAL_BACKEND_BASE_URL
    : DEFAULT_LOCAL_BACKEND_BASE_URL;
const backendBaseUrl =
    rawBackendBaseUrl && rawBackendBaseUrl.length > 0
        ? rawBackendBaseUrl.replace(/\/+$/, '')
        : fallbackBackendBaseUrl;

bootstrapLogger.info(`Using backend base URL: ${backendBaseUrl}`);

const traceApiToken = process.env.TRACE_API_TOKEN?.trim();
const nodeEnv = process.env.NODE_ENV || DEFAULT_RUNTIME_NODE_ENV;
const isProduction = nodeEnv === 'production';

export const runtimeConfig = {
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
    botMentionNames: getStringArrayEnv(
        'BOT_MENTION_NAMES',
        envDefaultValues.BOT_MENTION_NAMES
    ),
    env: nodeEnv,
    isProduction,
    isDevelopment: !isProduction,
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
    costEstimator: {
        enabled: getBooleanEnv(
            'COST_ESTIMATOR_ENABLED',
            envDefaultValues.COST_ESTIMATOR_ENABLED
        ),
    },
    realtimeFilter: {
        enabled: getBooleanEnv(
            'REALTIME_FILTER_ENABLED',
            envDefaultValues.REALTIME_FILTER_ENABLED
        ),
    },
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
