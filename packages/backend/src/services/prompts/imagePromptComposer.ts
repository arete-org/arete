/**
 * @description: Builds the system and developer prompts that backend-owned image generation sends to the runtime.
 * @footnote-scope: core
 * @footnote-module: BackendImagePromptComposer
 * @footnote-risk: high - Prompt composition mistakes here can change image behavior, safety, or parity.
 * @footnote-ethics: high - Image prompt framing directly affects user-visible generated content.
 */
import { runtimeConfig } from '../../config.js';
import type { BotProfileConfig } from '../../config/profile.js';
import { promptRegistry, renderPrompt } from './promptRegistry.js';
import { buildProfileOverlaySystemMessage } from './profilePromptOverlay.js';

const ANNOTATION_MESSAGE_LIMIT = 2000;

type ComposeImagePromptsInput = {
    prompt: string;
    allowPromptAdjustment: boolean;
    size: string;
    quality: string;
    background: string;
    style: string;
    user: {
        username: string;
        nickname: string;
        guildName: string;
    };
};

const calculateRemainingRatio = (prompt: string): number => {
    const remaining = Math.max(0, ANNOTATION_MESSAGE_LIMIT - prompt.length);
    return remaining / ANNOTATION_MESSAGE_LIMIT;
};

const sanitize = (value: string | null | undefined): string | null => {
    if (!value) {
        return null;
    }

    return value.replace(/"/g, '\\"');
};

const buildDeveloperPrompt = (
    input: ComposeImagePromptsInput,
    profile: BotProfileConfig
): string => {
    const adjustmentClause = input.allowPromptAdjustment
        ? `You may refine the prompt for clarity, composition, or safety while preserving the user's intent. Prefer concise additions that fill missing scene/style/lighting gaps. Aim to stay within ~${Math.max(0, Math.round(calculateRemainingRatio(input.prompt) * 100))}% of the current length; keep expansions minimal when space is low.`
        : 'Do not modify, expand, or rephrase the prompt; use it exactly as provided.';

    const safeUsername = sanitize(input.user.username);
    const safeNickname = sanitize(input.user.nickname);
    const safeGuildName = sanitize(input.user.guildName);
    const requesterName = safeNickname || safeUsername || null;

    const userContext = [
        safeUsername
            ? `The user invoking the command is "${safeUsername}".`
            : '',
        safeNickname ? `Their server nickname is "${safeNickname}".` : '',
        safeGuildName
            ? `This generation takes place in the server "${safeGuildName}".`
            : '',
    ]
        .filter(Boolean)
        .join(' ');

    const annotationInstruction = requesterName
        ? `Provide a brief annotation that addresses "${requesterName}" by name and explores the creative intent in two or three sentences.`
        : 'Provide a brief annotation that explores the creative intent in two or three sentences.';

    return renderPrompt('discord.image.developer', {
        botProfileDisplayName: profile.displayName,
        userContext,
        size: input.size,
        quality: input.quality,
        background: input.background,
        style: input.style,
        adjustmentClause,
        reflectionInstruction: annotationInstruction,
    }).content;
};

export const composeImagePrompts = (
    input: ComposeImagePromptsInput,
    profile: BotProfileConfig = runtimeConfig.profile
): {
    systemPrompt: string;
    developerPrompt: string;
} => {
    const variables = {
        botProfileDisplayName: profile.displayName,
    };
    const corePrompt = promptRegistry.renderPrompt(
        'discord.image.system',
        variables
    ).content;
    const overlayPrompt = buildProfileOverlaySystemMessage(
        profile,
        'image.system'
    );
    const defaultPersonaPrompt = promptRegistry.renderPrompt(
        'discord.image.persona.footnote',
        variables
    ).content;
    const systemPrompt = `${corePrompt.trimEnd()}\n\n${
        overlayPrompt ?? defaultPersonaPrompt
    }`.trim();

    return {
        systemPrompt,
        developerPrompt: buildDeveloperPrompt(input, profile),
    };
};
