/**
 * @description: Initializes the Discord bot prompt registry and exposes prompt helpers.
 * @footnote-scope: utility
 * @footnote-module: PromptConfig
 * @footnote-risk: medium - Missing prompts can break bot replies or image flows at runtime.
 * @footnote-ethics: high - Prompt setup shapes bot behavior, safety, and disclosure.
 */

import {
    type PromptKey,
    type PromptVariables,
} from '@footnote/prompts';
import { promptConfigPath, runtimeConfig } from './runtime.js';
import { createDiscordPromptRegistry } from './promptRegistryFactory.js';
import {
    prependProfileOverlaySystemMessageToConversation,
    renderPromptWithActivePersonaLayer,
    type PromptConversationMessage,
    type PromptConversationOverlayResult,
} from './promptComposition.js';
import type { ProfilePromptOverlayUsage } from './profilePromptOverlay.js';

/**
 * Active prompt registry for the Discord bot, including optional file-based
 * overrides.
 */
export const promptRegistry = createDiscordPromptRegistry(promptConfigPath);

const REQUIRED_PROMPT_KEYS: PromptKey[] = [
    'discord.chat.system',
    'discord.chat.persona.footnote',
    'discord.image.system',
    'discord.image.persona.footnote',
    'discord.image.developer',
    'discord.news.system',
    'discord.planner.system',
    'discord.realtime.system',
    'discord.realtime.persona.footnote',
    'discord.summarizer.system',
];

// Fail fast during startup so missing prompt definitions never surface mid-request.
promptRegistry.assertKeys(REQUIRED_PROMPT_KEYS);

/**
 * Shared prompt render helper bound to the active Discord prompt registry.
 */
export const renderPrompt = (
    key: PromptKey,
    variables: PromptVariables = {}
) =>
    promptRegistry.renderPrompt(key, {
        botProfileDisplayName: runtimeConfig.profile.displayName,
        ...variables,
    });

/**
 * Resolves the default persona key for a given usage context when no runtime
 * overlay is configured.
 */
const resolveDefaultPersonaPromptKey = (
    usage: ProfilePromptOverlayUsage
): PromptKey => {
    switch (usage) {
        case 'image.system':
        case 'image.developer':
            return 'discord.image.persona.footnote';
        case 'realtime':
            return 'discord.realtime.persona.footnote';
        case 'reflect':
        case 'provenance':
            return 'discord.chat.persona.footnote';
        default:
            return 'discord.chat.persona.footnote';
    }
};

/**
 * Prompt resolution order for Discord bot text generation:
 * 1) shared defaults.yaml
 * 2) optional PROMPT_CONFIG_PATH override for the same key
 * 3) variable interpolation
 * 4) one active persona layer (overlay when configured, otherwise default Footnote persona key)
 */
export const renderPromptWithProfileOverlay = (
    key: PromptKey,
    usage: ProfilePromptOverlayUsage,
    variables: PromptVariables = {}
): string =>
    renderPromptWithActivePersonaLayer({
        registry: promptRegistry,
        profile: runtimeConfig.profile,
        coreKey: key,
        defaultPersonaKey: resolveDefaultPersonaPromptKey(usage),
        usage,
        variables: {
            botProfileDisplayName: runtimeConfig.profile.displayName,
            ...variables,
        },
    });

/**
 * Adds the runtime profile overlay as a separate system message when present.
 * Reflect request building uses this so overlay behavior stays consistent while
 * still preserving existing reflect message ordering.
 */
export const prependProfileOverlaySystemMessage = (
    conversation: readonly PromptConversationMessage[],
    usage: ProfilePromptOverlayUsage
): PromptConversationOverlayResult =>
    prependProfileOverlaySystemMessageToConversation(
        runtimeConfig.profile,
        usage,
        conversation
    );

export type { PromptConversationMessage, PromptConversationOverlayResult };
