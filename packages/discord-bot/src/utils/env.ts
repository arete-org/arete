/**
 * @file env.ts
 * @description Environment variable configuration and validation for the Discord bot.
 * Handles loading environment variables from .env file and validating required configurations.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { PromptRegistry, PromptKey, renderPrompt as sharedRenderPrompt, setActivePromptRegistry } from '@arete/shared';
import { logger } from './logger.js';

// Get the current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Calculate .env file path
const envPath = path.resolve(__dirname, '../../../../.env');
logger.debug(`Loading environment variables from: ${envPath}`);

// Load environment variables from .env file in the root directory
try { 
  const { error, parsed } = dotenv.config({ path: envPath }); 

  if (error) {
    logger.warn(`Failed to load .env file: ${error.message}`);
  } else if (parsed) {
    logger.debug(`Loaded environment variables: ${Object.keys(parsed).join(', ')}`);
  }
} catch { 
  logger.warn("No .env found (expected on Fly.io deployments)");
}

/**
 * List of required environment variables that must be set for the application to run.
 * @type {readonly string[]}
 */
const REQUIRED_ENV_VARS: readonly string[] = [
  'DISCORD_TOKEN',    // Discord bot token for authentication
  'CLIENT_ID',        // Discord application client ID
  'GUILD_ID',         // Discord server (guild) ID
  'OPENAI_API_KEY',   // OpenAI API key for AI functionality
  'DEVELOPER_USER_ID' // Discord user ID of the developer for privileged access
] as const;

/**
 * Default rate limit configurations
 */
const DEFAULT_RATE_LIMITS: Record<string, any> = {
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
} as const;

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
const webBaseUrl = rawWebBaseUrl && rawWebBaseUrl.length > 0
  ? rawWebBaseUrl
  : fallbackWebBaseUrl;

if (!webBaseUrl) {
  throw new Error(
    'Missing WEB_BASE_URL. Set WEB_BASE_URL explicitly or deploy via Fly.io so FLY_APP_NAME provides the default.'
  );
}
logger.info(`Using web base URL: ${webBaseUrl}`);

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
  promptConfigPath,
  webBaseUrl,
  
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
  }

} as const;
