/**
 * @description: Builds system and developer prompts for image generation requests.
 * @arete-scope: utility
 * @arete-module: ImagePromptBuilder
 * @arete-risk: moderate - Prompt errors can degrade outputs or raise costs.
 * @arete-ethics: moderate - Prompt framing shapes model behavior and safety.
 */
import { renderPrompt } from '../../utils/env.js';

import type {
    ImageBackgroundType,
    ImageQualityType,
    ImageSizeType,
    ImageStylePreset,
} from './types.js';

interface DeveloperPromptOptions {
    allowPromptAdjustment: boolean;
    size: ImageSizeType;
    quality: ImageQualityType;
    background: ImageBackgroundType;
    style: ImageStylePreset;
    username: string; // Discord username of the user that called the command
    nickname: string; // Discord nickname of the user that called the command
    guildName: string; // Discord server name where the command was called
    remainingPromptRatio?: number;
}

export function buildDeveloperPrompt(options: DeveloperPromptOptions): string {
    const sanitize = (value: string | null | undefined): string | null => {
        if (!value) {
            return null;
        }

        return value.replace(/"/g, '\\"');
    };

    const adjustmentClause = options.allowPromptAdjustment
        ? `You may refine the prompt for clarity, composition, or safety while preserving the user's intent. Prefer concise additions that fill missing scene/style/lighting gaps. Aim to stay within ~${Math.max(0, Math.round((options.remainingPromptRatio ?? 1) * 100))}% of the current length; keep expansions minimal when space is low.`
        : 'Do not modify, expand, or rephrase the prompt; use it exactly as provided.';

    const safeUsername = sanitize(options.username);
    const safeNickname = sanitize(options.nickname);
    const safeGuildName = sanitize(options.guildName);
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

    const { content } = renderPrompt('discord.image.developer', {
        userContext,
        size: options.size,
        quality: options.quality,
        background: options.background,
        style: options.style,
        adjustmentClause,
        reflectionInstruction: annotationInstruction,
    });

    return content;
}
