/**
 * @description: Loads and validates Discord bot environment configuration and defaults.
 * @arete-scope: utility
 * @arete-module: EnvConfig
 * @arete-risk: high - Misconfiguration can break auth, rate limits, or cost tracking.
 * @arete-ethics: moderate - Incorrect settings can alter safety behavior or disclosure.
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { PromptKey } from '@arete/backend/shared';
import { logger } from './logger.js';

// Get the current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Calculate .env file path
const envPath = path.resolve(__dirname, '../../../../.env');
logger.debug(`Loading environment variables from: ${envPath}`);

// Load environment variables from .env file in the root directory (when present).
if (fs.existsSync(envPath)) {
  const { error, parsed } = dotenv.config({ path: envPath });

  if (error) {
    logger.warn(`Failed to load .env file: ${error.message}`);
  } else if (parsed) {
    logger.debug(`Loaded environment variables: ${Object.keys(parsed).join(', ')}`);
  }
} else {
  logger.debug('No .env file found; relying on injected environment variables.');
}

// Import shared module after environment has been configured so it reads the correct values.
const {
  PromptRegistry,
  renderPrompt: sharedRenderPrompt,
  setActivePromptRegistry
}: {
  PromptRegistry: typeof import('@arete/backend/shared').PromptRegistry;
  renderPrompt: typeof import('@arete/backend/shared').renderPrompt;
  setActivePromptRegistry: typeof import('@arete/backend/shared').setActivePromptRegistry;
} = await import('@arete/backend/shared');

/**
 * List of required environment variables that must be set for the application to run.
 * @type {readonly string[]}
 */
const REQUIRED_ENV_VARS: readonly string[] = [
  'DISCORD_TOKEN',    // Discord bot token for authentication
  'CLIENT_ID',        // Discord application client ID
  'GUILD_ID',         // Discord server (guild) ID
  'OPENAI_API_KEY',   // OpenAI API key for AI functionality
  'DEVELOPER_USER_ID', // Discord user ID of the developer for privileged access
  'INCIDENT_PSEUDONYMIZATION_SECRET' // Secret key for HMAC pseudonymization of Discord IDs
] as const;

type RateLimitDefaults = {
  USER_LIMIT: number;
  USER_WINDOW_MS: number;
  CHANNEL_LIMIT: number;
  CHANNEL_WINDOW_MS: number;
  GUILD_LIMIT: number;
  GUILD_WINDOW_MS: number;
  RATE_LIMIT_USER: 'true' | 'false';
  RATE_LIMIT_CHANNEL: 'true' | 'false';
  RATE_LIMIT_GUILD: 'true' | 'false';
};

/**
 * Default rate limit configurations
 */
const DEFAULT_RATE_LIMITS: RateLimitDefaults = {
  // Per-user: 5 messages per minute
  USER_LIMIT: 5,
  USER_WINDOW_MS: 60_000,
  // Per-channel: 10 messages per minute
  CHANNEL_LIMIT: 10,
  CHANNEL_WINDOW_MS: 60_000,
  // Per-guild: 20 messages per minute
  GUILD_LIMIT: 20,
  GUILD_WINDOW_MS: 60_000,
  // Whether to enable each type of rate limiting
  RATE_LIMIT_USER: 'true',
  RATE_LIMIT_CHANNEL: 'true',
  RATE_LIMIT_GUILD: 'true'
};

/**
 * Limits on channel/thread visibility
 */
const DEFAULT_VISIBILITY_LIMITS = {
  ALLOW_THREAD_RESPONSES: true,
  ALLOWED_THREAD_IDS: [""] // Comma-separated list of thread IDs; takes priority over ALLOW_THREAD_RESPONSES
} as const;

/**
 * Default configuration for limiting back-and-forth conversations with other bots
 */
const DEFAULT_BOT_INTERACTION_LIMITS = {
  MAX_BACK_AND_FORTH: 2,
  COOLDOWN_MS: 5 * 60_000,
  CONVERSATION_TTL_MS: 10 * 60_000,
  ACTION: 'react' as const,
  REACTION: '👍'
};

/**
 * Default configuration for the channel catch-up logic
 * @type {Object}
 * @property {number} AFTER_MESSAGES - The number of messages to send after the last message
 * @property {number} IF_MENTIONED_AFTER_MESSAGES - The number of messages to send if the user is mentioned
 * @property {number} STALE_COUNTER_TTL_MS - The time to live for the stale counter
 */
const DEFAULT_CATCH_UP_LIMITS = {
  AFTER_MESSAGES: 10,
  IF_MENTIONED_AFTER_MESSAGES: 5,
  STALE_COUNTER_TTL_MS: 60 * 60_000
} as const;

/**
 * Default configuration for the channel context manager
 * @type {Object}
 * @property {boolean} ENABLED - Whether the channel context manager is enabled
 * @property {number} MAX_MESSAGES_PER_CHANNEL - The maximum number of messages to keep per channel
 * @property {number} MESSAGE_RETENTION_MS - The time to keep messages per channel
 * @property {number} EVICTION_INTERVAL_MS - The interval to evict messages per channel
 */
const DEFAULT_CONTEXT_MANAGER_CONFIG = {
  ENABLED: true,
  MAX_MESSAGES_PER_CHANNEL: 50,
  MESSAGE_RETENTION_MS: 60 * 60_000,
  EVICTION_INTERVAL_MS: 5 * 60_000
} as const;

/**
 * Default configuration for the cost estimator
 * @type {Object}
 * @property {boolean} ENABLED - Whether the cost estimator is enabled
 */
const DEFAULT_COST_ESTIMATOR_CONFIG = {
  ENABLED: true
} as const;

/**
 * Default bot mention names for engagement detection
 * @type {string[]}
 * @property {string[]} BOT_MENTION_NAMES - Comma-separated list of names the bot responds to (default: "arete,ari")
 */
const DEFAULT_BOT_MENTION_NAMES = [
  'arete',
  'ari'
] as const;

/**
 * Default engagement scoring weights (0-1 range, higher = more influence)
 * @type {Object}
 * @property {number} MENTION - Weight for direct mentions/questions (default 0.3)
 * @property {number} QUESTION - Weight for question marks and interrogatives (default 0.2)
 * @property {number} TECHNICAL - Weight for technical keywords (default 0.15)
 * @property {number} HUMAN_ACTIVITY - Weight for recent human message ratio (default 0.15)
 * @property {number} COST_SATURATION - Weight for cost velocity concerns (default 0.1, negative signal)
 * @property {number} BOT_NOISE - Weight for bot message ratio (default 0.05, negative signal)
 * @property {number} DM_BOOST - Multiplier for DM contexts (default 1.5)
 * @property {number} DECAY - Time decay factor for message recency (default 0.05)
 */
const DEFAULT_ENGAGEMENT_WEIGHTS = {
  MENTION: 0.3,
  QUESTION: 0.2,
  TECHNICAL: 0.15,
  HUMAN_ACTIVITY: 0.15,
  COST_SATURATION: 0.1,
  BOT_NOISE: 0.05,
  DM_BOOST: 1.5,
  DECAY: 0.05
} as const;

/**
 * Default engagement behavior preferences
 * @type {Object}
 * @property {string} IGNORE_MODE - How to acknowledge when skipping: 'silent' or 'react'
 * @property {string} REACTION_EMOJI - Emoji to use when ignoreMode=react
 * @property {number} MIN_ENGAGE_THRESHOLD - Minimum score to engage (0-1)
 * @property {number} PROBABILISTIC_BAND_LOW - Lower bound of grey zone for LLM refinement
 * @property {number} PROBABILISTIC_BAND_HIGH - Upper bound of grey zone for LLM refinement
 * @property {boolean} ENABLE_LLM_REFINEMENT - Whether to use LLM to refine scores in grey zone
 */
const DEFAULT_ENGAGEMENT_PREFERENCES = {
  IGNORE_MODE: 'silent' as const,
  REACTION_EMOJI: '👍',
  MIN_ENGAGE_THRESHOLD: 0.5,
  PROBABILISTIC_BAND_LOW: 0.4,
  PROBABILISTIC_BAND_HIGH: 0.6,
  ENABLE_LLM_REFINEMENT: false
} as const;

/**
 * Default realtime filter configuration
 * Enabled by default, but we provide a feature flag to disable it if desired.
 * @type {Object}
 * @property {boolean} ENABLED - Whether the realtime filter is enabled
 */
const DEFAULT_REALTIME_FILTER_CONFIG = {
  ENABLED: true
} as const;

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
  logger.debug(`Rate limits: ${JSON.stringify(DEFAULT_RATE_LIMITS)}`);
}

// Validate environment variables on startup
validateEnvironment();

// Resolve the optional prompt override configuration path. 
// Allows pointing to a custom YAML file to tweak the bot's behavior.
const rawPromptConfigPath = process.env.PROMPT_CONFIG_PATH;
const promptConfigPath = rawPromptConfigPath
  ? path.isAbsolute(rawPromptConfigPath)
    ? rawPromptConfigPath
    : path.resolve(__dirname, '../../../../', rawPromptConfigPath)
  : undefined;

if (promptConfigPath) {
  logger.info(`Loading prompt overrides from: ${promptConfigPath}`);
}

const flyAppName = process.env.FLY_APP_NAME?.trim();
// Default to the Fly-provisioned hostname when present so deployments work without extra config.
const fallbackWebBaseUrl = flyAppName ? `https://${flyAppName}.fly.dev` : undefined;
const rawWebBaseUrl = process.env.WEB_BASE_URL?.trim();
const fallbackLocalBaseUrl = 'http://localhost:8080';
const webBaseUrl = rawWebBaseUrl && rawWebBaseUrl.length > 0
  ? rawWebBaseUrl
  : fallbackWebBaseUrl || fallbackLocalBaseUrl;

if (!webBaseUrl) {
  throw new Error(
    'Missing WEB_BASE_URL. Set WEB_BASE_URL explicitly or deploy via Fly.io so FLY_APP_NAME provides the default.'
  );
}
logger.info(`Using web base URL: ${webBaseUrl}`);

const rawBackendBaseUrl = process.env.BACKEND_BASE_URL?.trim();
const fallbackBackendBaseUrl = flyAppName
  ? 'http://arete-backend.internal:3000'
  : 'http://localhost:3000';
const backendBaseUrl = rawBackendBaseUrl && rawBackendBaseUrl.length > 0
  ? rawBackendBaseUrl.replace(/\/+$/, '')
  : fallbackBackendBaseUrl;

logger.info(`Using backend base URL: ${backendBaseUrl}`);
const traceApiToken = process.env.TRACE_API_TOKEN?.trim();

// Instantiate the shared prompt registry and expose it to downstream modules.
export const promptRegistry = new PromptRegistry({ overridePath: promptConfigPath });
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
  'discord.summarizer.system'
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
    logger.warn(
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
function getStringArrayEnv(key: string, defaultValue: readonly string[]): string[] {
  const value = process.env[key];
  if (!value) {
    return [...defaultValue];
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    logger.warn(
      `Ignoring ${key} because it did not contain any valid thread identifiers. Falling back to default (${defaultValue.join(', ') || 'none'}).`
    );
    return [...defaultValue];
  }

  return entries;
}

type BotInteractionAction = 'ignore' | 'react';

/**
 * Reads the preferred action to take once the bot-to-bot conversation limit is reached
 */
function getBotInteractionActionEnv(key: string, defaultValue: BotInteractionAction): BotInteractionAction {
  const value = process.env[key];
  if (!value) return defaultValue;

  const normalized = value.trim().toLowerCase();
  if (normalized === 'ignore' || normalized === 'react') {
    return normalized;
  }

  logger.warn(
    `Ignoring invalid bot interaction action for ${key}: "${value}". Expected "ignore" or "react"; using default (${defaultValue}).`
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
export const config = {
  // Bot configuration
  token: process.env.DISCORD_TOKEN!,
  clientId: process.env.CLIENT_ID!,
  guildId: process.env.GUILD_ID!,
  openaiApiKey: process.env.OPENAI_API_KEY!,
  incidentPseudonymizationSecret: process.env.INCIDENT_PSEUDONYMIZATION_SECRET!,
  promptConfigPath,
  webBaseUrl,
  backendBaseUrl,
  traceApiToken,
  
  // Bot mention names for engagement detection
  botMentionNames: getStringArrayEnv('BOT_MENTION_NAMES', DEFAULT_BOT_MENTION_NAMES),
  
  // Environment
  env: process.env.NODE_ENV || 'development',
  isProduction: (process.env.NODE_ENV || 'development') === 'production',
  
  // Rate limiting configuration
  rateLimits: {
    user: {
      enabled: getBooleanEnv('RATE_LIMIT_USER', DEFAULT_RATE_LIMITS.RATE_LIMIT_USER === 'true'),
      limit: getNumberEnv('USER_RATE_LIMIT', DEFAULT_RATE_LIMITS.USER_LIMIT),
      windowMs: getNumberEnv('USER_RATE_WINDOW_MS', DEFAULT_RATE_LIMITS.USER_WINDOW_MS)
    },
    channel: {
      enabled: getBooleanEnv('RATE_LIMIT_CHANNEL', DEFAULT_RATE_LIMITS.RATE_LIMIT_CHANNEL === 'true'),
      limit: getNumberEnv('CHANNEL_RATE_LIMIT', DEFAULT_RATE_LIMITS.CHANNEL_LIMIT),
      windowMs: getNumberEnv('CHANNEL_RATE_WINDOW_MS', DEFAULT_RATE_LIMITS.CHANNEL_WINDOW_MS)
    },
    guild: {
      enabled: getBooleanEnv('RATE_LIMIT_GUILD', DEFAULT_RATE_LIMITS.RATE_LIMIT_GUILD === 'true'),
      limit: getNumberEnv('GUILD_RATE_LIMIT', DEFAULT_RATE_LIMITS.GUILD_LIMIT),
      windowMs: getNumberEnv('GUILD_RATE_WINDOW_MS', DEFAULT_RATE_LIMITS.GUILD_WINDOW_MS)
    }
  },

  // Behavioural controls to prevent getting stuck in endless loops with other bots
  botInteraction: {
    maxBackAndForth: getNumberEnv('BOT_BACK_AND_FORTH_LIMIT', DEFAULT_BOT_INTERACTION_LIMITS.MAX_BACK_AND_FORTH),
    cooldownMs: getNumberEnv('BOT_BACK_AND_FORTH_COOLDOWN_MS', DEFAULT_BOT_INTERACTION_LIMITS.COOLDOWN_MS),
    conversationTtlMs: getNumberEnv('BOT_BACK_AND_FORTH_TTL_MS', DEFAULT_BOT_INTERACTION_LIMITS.CONVERSATION_TTL_MS),
    afterLimitAction: getBotInteractionActionEnv('BOT_BACK_AND_FORTH_ACTION', DEFAULT_BOT_INTERACTION_LIMITS.ACTION),
    reactionEmoji: process.env.BOT_BACK_AND_FORTH_REACTION?.trim() || DEFAULT_BOT_INTERACTION_LIMITS.REACTION
  },

  // Message catch-up tuning
  catchUp: {
    afterMessages: getNumberEnv('CATCHUP_AFTER_MESSAGES', DEFAULT_CATCH_UP_LIMITS.AFTER_MESSAGES),
    ifMentionedAfterMessages: getNumberEnv(
      'CATCHUP_IF_MENTIONED_AFTER_MESSAGES',
      DEFAULT_CATCH_UP_LIMITS.IF_MENTIONED_AFTER_MESSAGES
    ),
    staleCounterTtlMs: getNumberEnv('STALE_COUNTER_TTL_MS', DEFAULT_CATCH_UP_LIMITS.STALE_COUNTER_TTL_MS)
  },

  // Channel/thread visibility controls
  visibility: {
    allowThreadResponses: getBooleanEnv('ALLOW_THREAD_RESPONSES', DEFAULT_VISIBILITY_LIMITS.ALLOW_THREAD_RESPONSES),
    allowedThreadIds: getStringArrayEnv('ALLOWED_THREAD_IDS', DEFAULT_VISIBILITY_LIMITS.ALLOWED_THREAD_IDS)
  },

  // Channel context manager configuration
  contextManager: {
    enabled: getBooleanEnv('CONTEXT_MANAGER_ENABLED', DEFAULT_CONTEXT_MANAGER_CONFIG.ENABLED),
    maxMessagesPerChannel: getNumberEnv(
      'CONTEXT_MANAGER_MAX_MESSAGES',
      DEFAULT_CONTEXT_MANAGER_CONFIG.MAX_MESSAGES_PER_CHANNEL
    ),
    messageRetentionMs: getNumberEnv(
      'CONTEXT_MANAGER_RETENTION_MS',
      DEFAULT_CONTEXT_MANAGER_CONFIG.MESSAGE_RETENTION_MS
    ),
    evictionIntervalMs: getNumberEnv(
      'CONTEXT_MANAGER_EVICTION_INTERVAL_MS',
      DEFAULT_CONTEXT_MANAGER_CONFIG.EVICTION_INTERVAL_MS
    )
  },

  // Cost estimator configuration
  costEstimator: {
    enabled: getBooleanEnv('COST_ESTIMATOR_ENABLED', DEFAULT_COST_ESTIMATOR_CONFIG.ENABLED)
  },

  // Realtime engagement filter configuration
  realtimeFilter: {
    enabled: getBooleanEnv('REALTIME_FILTER_ENABLED', DEFAULT_REALTIME_FILTER_CONFIG.ENABLED)
  },

  // Engagement scoring weights
  engagementWeights: {
    mention: getNumberEnv('ENGAGEMENT_WEIGHT_MENTION', DEFAULT_ENGAGEMENT_WEIGHTS.MENTION),
    question: getNumberEnv('ENGAGEMENT_WEIGHT_QUESTION', DEFAULT_ENGAGEMENT_WEIGHTS.QUESTION),
    technical: getNumberEnv('ENGAGEMENT_WEIGHT_TECHNICAL', DEFAULT_ENGAGEMENT_WEIGHTS.TECHNICAL),
    humanActivity: getNumberEnv('ENGAGEMENT_WEIGHT_HUMAN_ACTIVITY', DEFAULT_ENGAGEMENT_WEIGHTS.HUMAN_ACTIVITY),
    costSaturation: getNumberEnv('ENGAGEMENT_WEIGHT_COST_SATURATION', DEFAULT_ENGAGEMENT_WEIGHTS.COST_SATURATION),
    botNoise: getNumberEnv('ENGAGEMENT_WEIGHT_BOT_NOISE', DEFAULT_ENGAGEMENT_WEIGHTS.BOT_NOISE),
    dmBoost: getNumberEnv('ENGAGEMENT_WEIGHT_DM_BOOST', DEFAULT_ENGAGEMENT_WEIGHTS.DM_BOOST),
    decay: getNumberEnv('ENGAGEMENT_WEIGHT_DECAY', DEFAULT_ENGAGEMENT_WEIGHTS.DECAY)
  },

  // Engagement behavior preferences
  engagementPreferences: {
    ignoreMode: (process.env.ENGAGEMENT_IGNORE_MODE?.trim().toLowerCase() === 'react' ? 'react' : 'silent') as 'silent' | 'react',
    reactionEmoji: process.env.ENGAGEMENT_REACTION_EMOJI?.trim() || DEFAULT_ENGAGEMENT_PREFERENCES.REACTION_EMOJI,
    minEngageThreshold: getNumberEnv('ENGAGEMENT_MIN_THRESHOLD', DEFAULT_ENGAGEMENT_PREFERENCES.MIN_ENGAGE_THRESHOLD),
    probabilisticBand: [
      getNumberEnv('ENGAGEMENT_PROBABILISTIC_LOW', DEFAULT_ENGAGEMENT_PREFERENCES.PROBABILISTIC_BAND_LOW),
      getNumberEnv('ENGAGEMENT_PROBABILISTIC_HIGH', DEFAULT_ENGAGEMENT_PREFERENCES.PROBABILISTIC_BAND_HIGH)
    ] as [number, number],
    enableLLMRefinement: getBooleanEnv('ENGAGEMENT_ENABLE_LLM_REFINEMENT', DEFAULT_ENGAGEMENT_PREFERENCES.ENABLE_LLM_REFINEMENT)
  }

} as const;
