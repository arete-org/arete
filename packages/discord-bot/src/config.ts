/**
 * @description: Public entry point for Discord bot startup config.
 * @footnote-scope: utility
 * @footnote-module: EnvConfig
 * @footnote-risk: high - Misconfiguration can break auth, rate limits, or cost tracking.
 * @footnote-ethics: medium - Incorrect settings can alter safety behavior or disclosure.
 */

import './config/bootstrap.js';

export {
    promptRegistry,
    renderPrompt,
    renderPromptWithProfileOverlay,
    prependProfileOverlaySystemMessage,
    type PromptConversationMessage,
    type PromptConversationOverlayResult,
} from './config/prompts.js';
export { runtimeConfig } from './config/runtime.js';
