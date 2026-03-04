/**
 * @description: Shared singleton backend API client for discord-bot runtime calls.
 * @footnote-scope: utility
 * @footnote-module: DiscordBotApiSingleton
 * @footnote-risk: high - Misconfigured singleton can impact all backend API calls in the bot process.
 * @footnote-ethics: medium - Centralized client behavior supports consistent fail-open handling.
 */

import { runtimeConfig } from '../config.js';
import { createDiscordApiClient, isDiscordApiClientError } from './index.js';

export const botApi = createDiscordApiClient({
    baseUrl: runtimeConfig.backendBaseUrl,
    traceApiToken: runtimeConfig.traceApiToken,
    defaultTimeoutMs: runtimeConfig.api.backendRequestTimeoutMs,
});

export { isDiscordApiClientError };
