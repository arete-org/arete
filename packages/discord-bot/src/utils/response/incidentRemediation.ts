/**
 * @description: Applies the under-review edit for reported assistant messages with idempotent safeguards.
 * @footnote-scope: interface
 * @footnote-module: IncidentRemediation
 * @footnote-risk: medium - Broken remediation can leave harmful content visible or overwrite the wrong message.
 * @footnote-ethics: high - Reporting remediation directly impacts user safety and transparency.
 */
import type { Message } from 'discord.js';
import type { IncidentRemediationState } from '@footnote/contracts/web';

export const UNDER_REVIEW_MARKER =
    'Under review: This assistant response was reported';
const UNDER_REVIEW_BANNER = `⚠️ ${UNDER_REVIEW_MARKER} and may contain harmful or incorrect guidance.`;
const UNDER_REVIEW_PLACEHOLDER =
    '[Original content hidden while this report is reviewed.]';
const DISCORD_MESSAGE_MAX_LENGTH = 2000;

/**
 * Result returned after the bot tries to apply the immediate under-review edit.
 */
export type IncidentRemediationOutcome = {
    state: Exclude<IncidentRemediationState, 'pending'>;
    notes: string;
};

/**
 * Builds the replacement message content for a reported assistant response. We
 * prefer spoiler-wrapping the original text and fall back to a placeholder
 * when Discord formatting rules would make that unsafe.
 */
export const buildUnderReviewContent = (
    originalContent: string
): { content: string; usedPlaceholder: boolean } => {
    const trimmedContent = originalContent.trim();
    const spoilerCandidate = `${UNDER_REVIEW_BANNER}\n\n||${trimmedContent}||`;
    const canUseSpoilerWrapping =
        trimmedContent.length > 0 &&
        !trimmedContent.includes('||') &&
        spoilerCandidate.length <= DISCORD_MESSAGE_MAX_LENGTH;

    if (canUseSpoilerWrapping) {
        return {
            content: spoilerCandidate,
            usedPlaceholder: false,
        };
    }

    return {
        content: `${UNDER_REVIEW_BANNER}\n\n${UNDER_REVIEW_PLACEHOLDER}`,
        usedPlaceholder: true,
    };
};

/**
 * Applies the under-review edit exactly once when the target message belongs to
 * this bot. Every non-success path returns an explicit outcome so the backend
 * can persist what really happened.
 */
export const remediateReportedAssistantMessage = async (
    message: Message
): Promise<IncidentRemediationOutcome> => {
    const botId = message.client.user?.id;
    if (!botId || message.author.id !== botId) {
        return {
            state: 'skipped_not_assistant',
            notes: 'Target message was not authored by this assistant.',
        };
    }

    if (message.content.includes(UNDER_REVIEW_MARKER)) {
        return {
            state: 'already_marked',
            notes: 'Target message was already marked under review.',
        };
    }

    try {
        const nextContent = buildUnderReviewContent(message.content ?? '');
        await message.edit({
            content: nextContent.content,
        });

        return {
            state: 'applied',
            notes: nextContent.usedPlaceholder
                ? 'Applied under-review warning with placeholder fallback.'
                : 'Applied under-review warning with spoiler wrapping.',
        };
    } catch (error) {
        return {
            state: 'failed',
            notes: `Failed to edit target message: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
};
