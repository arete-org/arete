/**
 * @description: Shared singleton backend API client for discord-bot runtime calls.
 * @arete-scope: utility
 * @arete-module: DiscordBotApiSingleton
 * @arete-risk: moderate - Misconfigured singleton can impact all backend API calls in the bot process.
 * @arete-ethics: moderate - Centralized client behavior supports consistent fail-open handling.
 */

import { config } from '../utils/env.js';
import {
    createDiscordApiClient,
    isDiscordApiClientError,
} from './index.js';

export const botApi = createDiscordApiClient({
    baseUrl: config.backendBaseUrl,
    traceApiToken: config.traceApiToken,
});

export { isDiscordApiClientError };
