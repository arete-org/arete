/**
 * @description: Builds realtime prompt context for audio sessions and participants.
 * @footnote-scope: core
 * @footnote-module: RealtimeContextBuilder
 * @footnote-risk: high - Context errors can degrade realtime responses or routing.
 * @footnote-ethics: high - Realtime transcripts impact privacy and consent.
 */
import { renderPromptWithProfileOverlay } from '../../config.js';

/**
 * Participant metadata included in realtime voice-session context.
 */
export interface RealtimeContextParticipant {
    id: string;
    displayName: string;
    isBot?: boolean;
}

/**
 * Input used to build one realtime session prompt.
 */
export interface RealtimeContextInput {
    participants: RealtimeContextParticipant[];
    transcripts?: string[];
}

interface RealtimeContextOutput {
    instructions: string;
    metadata: {
        participants: RealtimeContextParticipant[];
        transcripts: string[];
    };
    sessionContext: {
        participants: RealtimeContextParticipant[];
        transcripts?: string[];
    };
}

/**
 * Assembles realtime instructions from the active prompt plus participant and
 * transcript context.
 */
export class RealtimeContextBuilder {
    public buildContext(input: RealtimeContextInput): RealtimeContextOutput {
        const transcripts = input.transcripts ?? [];
        const roster =
            input.participants.length > 0
                ? input.participants
                      .map(
                          (participant) =>
                              `- ${participant.displayName}${participant.isBot ? ' (bot)' : ''}`
                      )
                      .join('\n')
                : '- (no other participants currently detected)';

        const transcriptBlock =
            transcripts.length > 0
                ? `\nRecent conversation summary:\n${transcripts.map((line) => `- ${line}`).join('\n')}`
                : '';

        const basePrompt = renderPromptWithProfileOverlay('realtime');
        const instructions = `${basePrompt}\n\nParticipants currently in the voice channel:\n${roster}${transcriptBlock}`;

        return {
            instructions,
            metadata: {
                participants: input.participants,
                transcripts,
            },
            sessionContext: {
                participants: input.participants,
                ...(transcripts.length > 0 ? { transcripts } : {}),
            },
        };
    }
}
