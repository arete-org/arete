/**
 * @description: Normalizes Discord conversation payloads into planner/runtime-friendly text messages.
 * @footnote-scope: core
 * @footnote-module: ChatConversationNormalization
 * @footnote-risk: medium - Incorrect normalization can hide important context or distort turn history.
 * @footnote-ethics: medium - Conversation shaping affects what the assistant sees and how it responds.
 */

import type {
    PostChatRequest,
    ChatConversationMessage,
} from '@footnote/contracts/web';

const DISCORD_CONTEXT_WINDOW_SIZE = 24;

type ChatConversationLogger = {
    debug: (message: string, meta?: Record<string, unknown>) => void;
};

const trimDiscordConversationWindow = (
    conversation: PostChatRequest['conversation']
): PostChatRequest['conversation'] => {
    // Keep all system messages, but cap non-system history so planner/generation
    // stay within a predictable context budget for Discord traffic.
    const retainedReverse: PostChatRequest['conversation'] = [];
    let nonSystemCount = 0;
    for (let index = conversation.length - 1; index >= 0; index -= 1) {
        const message = conversation[index];
        if (!message) {
            continue;
        }
        if (message.role === 'system') {
            retainedReverse.push(message);
            continue;
        }
        if (nonSystemCount >= DISCORD_CONTEXT_WINDOW_SIZE) {
            continue;
        }
        retainedReverse.push(message);
        nonSystemCount += 1;
    }

    return retainedReverse.reverse();
};

/**
 * Formats ISO timestamps into a short planner-friendly token (`YYYY-MM-DD HH:mm`).
 * Returns null when parsing fails so callers can fail open to plain message text.
 */
const formatTimestampForConversation = (
    isoTimestamp?: string
): string | null => {
    if (!isoTimestamp) {
        return null;
    }
    const date = new Date(isoTimestamp);
    if (Number.isNaN(date.getTime())) {
        return null;
    }
    const iso = date.toISOString();
    const [datePart, timePart] = iso.split('T');
    if (!datePart || !timePart) {
        return null;
    }

    const wholeTime = timePart.split('.')[0];
    if (!wholeTime) {
        return null;
    }

    const hhmm = wholeTime.slice(0, 5);
    return `${datePart} ${hhmm}`;
};

/**
 * Converts one Discord message into a planner-friendly sentence that preserves
 * who said what and when, while still fitting the plain text runtime seam.
 */
const formatDiscordConversationMessage = (
    message: PostChatRequest['conversation'][number],
    messageIndex: number
): string => {
    const trimmedContent = message.content.trim();
    const timestamp = formatTimestampForConversation(message.createdAt);
    const trimmedAuthorName = message.authorName?.trim();
    const trimmedAuthorId = message.authorId?.trim();
    const authorLabel = (
        trimmedAuthorName && trimmedAuthorName.length > 0
            ? trimmedAuthorName
            : trimmedAuthorId && trimmedAuthorId.length > 0
              ? trimmedAuthorId
              : 'Unknown'
    ).trim();

    if (!timestamp || authorLabel.length === 0) {
        // Fail open: keep original content if we cannot build metadata preamble.
        return trimmedContent;
    }

    const roleLabel = message.role === 'assistant' ? ' (bot)' : '';
    const preamble = `[${messageIndex}] At ${timestamp} ${authorLabel}${roleLabel} said:`;
    if (message.role === 'assistant') {
        return trimmedContent
            ? `${preamble} ${trimmedContent}`
            : `${preamble} Assistant response contained only non-text content.`;
    }
    return `${preamble} "${trimmedContent}"`;
};

export const normalizeDiscordConversation = (
    request: PostChatRequest,
    logger: ChatConversationLogger
): Array<Pick<ChatConversationMessage, 'role' | 'content'>> => {
    // Discord carries extra author/timestamp metadata. We fold that into plain
    // text so the planner can reason about conversational turns.
    const trimmedConversation = trimDiscordConversationWindow(
        request.conversation
    );
    let nonSystemIndex = 0;

    const normalized = trimmedConversation.map((message) => {
        if (message.role === 'system') {
            return {
                role: 'system' as const,
                content: message.content,
            };
        }

        const content = formatDiscordConversationMessage(
            message,
            nonSystemIndex
        );
        nonSystemIndex += 1;
        return {
            role: message.role,
            content,
        };
    });

    if (request.conversation.length > trimmedConversation.length) {
        logger.debug('conversation.trimmed', {
            originalLength: request.conversation.length,
            trimmedLength: trimmedConversation.length,
        });
    }

    return normalized;
};
