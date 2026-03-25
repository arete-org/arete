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
    renderPromptLayersWithActivePersona,
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
    'conversation.shared.system',
    'conversation.shared.persona.footnote',
    'discord.chat.system',
    'discord.chat.persona.footnote',
    'discord.image.system',
    'discord.image.persona.footnote',
    'discord.image.developer',
    'text.news.system',
    'chat.planner.system',
    'discord.realtime.system',
    'discord.realtime.persona.footnote',
    'discord.summarizer.system',
];

const promptSystemKeysByUsage = {
    'image.system': ['discord.image.system'],
    'image.developer': ['discord.image.developer'],
    realtime: ['conversation.shared.system', 'discord.realtime.system'],
    chat: ['conversation.shared.system', 'discord.chat.system'],
    provenance: ['conversation.shared.system', 'discord.chat.system'],
} as const satisfies Record<ProfilePromptOverlayUsage, readonly PromptKey[]>;

const promptPersonaKeysByUsage = {
    'image.system': ['discord.image.persona.footnote'],
    'image.developer': ['discord.image.persona.footnote'],
    realtime: [
        'conversation.shared.persona.footnote',
        'discord.realtime.persona.footnote',
    ],
    chat: [
        'conversation.shared.persona.footnote',
        'discord.chat.persona.footnote',
    ],
    provenance: [
        'conversation.shared.persona.footnote',
        'discord.chat.persona.footnote',
    ],
} as const satisfies Record<ProfilePromptOverlayUsage, readonly PromptKey[]>;

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
 * Prompt resolution order for Discord bot generation:
 * 1) shared defaults.yaml
 * 2) optional PROMPT_CONFIG_PATH override for the same key
 * 3) variable interpolation
 * 4) system layers for the active surface
 * 5) one active persona layer (overlay when configured, otherwise shared + surface default persona)
 */
export const renderPromptWithProfileOverlay = (
    usage: ProfilePromptOverlayUsage,
    variables: PromptVariables = {}
): string =>
    renderPromptLayersWithActivePersona({
        registry: promptRegistry,
        profile: runtimeConfig.profile,
        systemKeys: promptSystemKeysByUsage[usage],
        personaKeys: promptPersonaKeysByUsage[usage],
        usage,
        variables: {
            botProfileDisplayName: runtimeConfig.profile.displayName,
            ...variables,
        },
    });

/**
 * Adds the runtime profile overlay as a separate system message when present.
 * Chat request building uses this so overlay behavior stays consistent while
 * still preserving existing message ordering.
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
