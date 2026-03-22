/**
 * @description: Builds backend-owned realtime voice instructions from shared prompts and voice session context.
 * @footnote-scope: core
 * @footnote-module: RealtimePromptComposer
 * @footnote-risk: high - Incorrect prompt composition can degrade realtime responses or misapply profile overlays.
 * @footnote-ethics: high - Realtime prompt text shapes live voice behavior and user expectations.
 */
import type { InternalVoiceSessionContext } from '@footnote/contracts/voice';
import {
    renderConversationSystemPrompt,
    renderDefaultConversationPersonaPrompt,
} from './conversationPromptLayers.js';
import { buildProfileOverlaySystemMessage } from './profilePromptOverlay.js';
import { runtimeConfig } from '../../config.js';

const WHITESPACE_REGEX = /\s+/g;
const MAX_PARTICIPANT_LABEL_LENGTH = 128;
const MAX_TRANSCRIPT_LINE_LENGTH = 240;

const normalizeControlChars = (value: string): string => {
    let result = '';
    for (const char of value) {
        const code = char.charCodeAt(0);
        if (code < 32 || code === 127) {
            result += ' ';
        } else {
            result += char;
        }
    }
    return result;
};

const sanitizePromptLine = (
    value: string | undefined,
    maxLength: number,
    fallback: string
): string => {
    if (!value) {
        return fallback;
    }

    const normalized = normalizeControlChars(value)
        .replace(WHITESPACE_REGEX, ' ')
        .trim();
    if (!normalized) {
        return fallback;
    }

    if (normalized.length <= maxLength) {
        return normalized;
    }

    const trimLength = Math.max(1, maxLength - 3);
    return `${normalized.slice(0, trimLength)}...`;
};

const buildRealtimePersonaLayer = (): string => {
    const overlayMessage = buildProfileOverlaySystemMessage(
        runtimeConfig.profile,
        'realtime'
    );

    if (overlayMessage) {
        return overlayMessage;
    }

    return renderDefaultConversationPersonaPrompt('discord-realtime', {
        botProfileDisplayName: runtimeConfig.profile.displayName,
    });
};

const formatParticipantRoster = (
    participants: InternalVoiceSessionContext['participants']
): string => {
    if (!participants || participants.length === 0) {
        return '- (no other participants currently detected)';
    }

    return participants
        .map(
            (participant) => {
                const label = sanitizePromptLine(
                    participant.displayName,
                    MAX_PARTICIPANT_LABEL_LENGTH,
                    'Unknown participant'
                );
                return `- ${label}${participant.isBot ? ' (bot)' : ''}`;
            }
        )
        .join('\n');
};

const formatTranscriptBlock = (transcripts?: string[]): string => {
    if (!transcripts || transcripts.length === 0) {
        return '';
    }

    return `\nRecent conversation summary:\n${transcripts
        .map((line) =>
            `- ${sanitizePromptLine(
                line,
                MAX_TRANSCRIPT_LINE_LENGTH,
                '(redacted)'
            )}`
        )
        .join('\n')}`;
};

/**
 * Builds the full instructions string that the realtime runtime passes to the
 * provider session.
 */
export const buildRealtimeInstructions = (
    context: InternalVoiceSessionContext
): string => {
    const basePrompt = renderConversationSystemPrompt('discord-realtime', {
        botProfileDisplayName: runtimeConfig.profile.displayName,
    });
    const personaLayer = buildRealtimePersonaLayer();
    const roster = formatParticipantRoster(context.participants);
    const transcriptBlock = formatTranscriptBlock(context.transcripts);

    return `${basePrompt.trimEnd()}\n\n${personaLayer}\n\nParticipants currently in the voice channel:\n${roster}${transcriptBlock}`.trim();
};
