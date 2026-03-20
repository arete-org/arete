/**
 * @description: Builds backend-owned realtime voice instructions from shared prompts and voice session context.
 * @footnote-scope: core
 * @footnote-module: RealtimePromptComposer
 * @footnote-risk: high - Incorrect prompt composition can degrade realtime responses or misapply profile overlays.
 * @footnote-ethics: high - Realtime prompt text shapes live voice behavior and user expectations.
 */
import type { InternalVoiceSessionContext } from '@footnote/contracts/voice';
import { renderPrompt } from './promptRegistry.js';
import { buildProfileOverlaySystemMessage } from './profilePromptOverlay.js';
import { runtimeConfig } from '../../config.js';

const buildRealtimePersonaLayer = (): string => {
    const overlayMessage = buildProfileOverlaySystemMessage(
        runtimeConfig.profile,
        'realtime'
    );

    if (overlayMessage) {
        return overlayMessage;
    }

    return renderPrompt('discord.realtime.persona.footnote', {
        botProfileDisplayName: runtimeConfig.profile.displayName,
    }).content;
};

const formatParticipantRoster = (
    participants: InternalVoiceSessionContext['participants']
): string => {
    if (!participants || participants.length === 0) {
        return '- (no other participants currently detected)';
    }

    return participants
        .map(
            (participant) =>
                `- ${participant.displayName}${participant.isBot ? ' (bot)' : ''}`
        )
        .join('\n');
};

const formatTranscriptBlock = (transcripts?: string[]): string => {
    if (!transcripts || transcripts.length === 0) {
        return '';
    }

    return `\nRecent conversation summary:\n${transcripts
        .map((line) => `- ${line}`)
        .join('\n')}`;
};

/**
 * Builds the full instructions string that the realtime runtime passes to the
 * provider session.
 */
export const buildRealtimeInstructions = (
    context: InternalVoiceSessionContext
): string => {
    const basePrompt = renderPrompt('discord.realtime.system', {
        botProfileDisplayName: runtimeConfig.profile.displayName,
    }).content;
    const personaLayer = buildRealtimePersonaLayer();
    const roster = formatParticipantRoster(context.participants);
    const transcriptBlock = formatTranscriptBlock(context.transcripts);

    return `${basePrompt.trimEnd()}\n\n${personaLayer}\n\nParticipants currently in the voice channel:\n${roster}${transcriptBlock}`.trim();
};
