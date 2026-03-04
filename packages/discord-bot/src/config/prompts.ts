/**
 * @description: Initializes the Discord bot prompt registry and exposes prompt helpers.
 * @footnote-scope: utility
 * @footnote-module: PromptConfig
 * @footnote-risk: medium - Missing prompts can break bot replies or image flows at runtime.
 * @footnote-ethics: high - Prompt setup shapes bot behavior, safety, and disclosure.
 */

import {
    PromptRegistry,
    renderPrompt as sharedRenderPrompt,
    setActivePromptRegistry,
    type PromptKey,
} from '../utils/prompts/promptRegistry.js';
import { promptConfigPath } from './runtime.js';

/**
 * Active prompt registry for the Discord bot, including optional file-based
 * overrides.
 */
export const promptRegistry = new PromptRegistry({
    overridePath: promptConfigPath,
});

setActivePromptRegistry(promptRegistry);

const REQUIRED_PROMPT_KEYS: PromptKey[] = [
    'discord.chat.system',
    'discord.image.system',
    'discord.image.developer',
    'discord.news.system',
    'discord.planner.system',
    'discord.realtime.system',
    'discord.summarizer.system',
];

// Fail fast during startup so missing prompt definitions never surface mid-request.
promptRegistry.assertKeys(REQUIRED_PROMPT_KEYS);

/**
 * Shared prompt render helper bound to the active Discord prompt registry.
 */
export const renderPrompt = sharedRenderPrompt;
