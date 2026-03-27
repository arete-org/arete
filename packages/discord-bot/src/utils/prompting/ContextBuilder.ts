/**
 * @description: Builds message context payloads for LLM prompts and logging.
 * @footnote-scope: core
 * @footnote-module: ContextBuilder
 * @footnote-risk: high - Context mistakes can mislead model outputs or omit safeguards.
 * @footnote-ethics: high - Context selection influences user privacy and fairness.
 */
import { Message } from 'discord.js';
import { logger } from '../logger.js';
import { renderPrompt, runtimeConfig } from '../../config.js';

/**
 * Minimal prompt message shape shared across Discord prompt-building helpers.
 */
export type PromptMessage = {
    role: 'user' | 'assistant' | 'system' | 'developer';
    content: string;
};

/**
 * Returns whether verbose prompt-context logging is enabled for debugging.
 */
export const isFullContextLoggingEnabled = (): boolean =>
    runtimeConfig.debug.verboseContextLoggingEnabled;

/**
 * Logs the full prompt context only when the explicit debug flag is enabled.
 */
export const logContextIfVerbose = (context: PromptMessage[]): void => {
    if (!isFullContextLoggingEnabled()) {
        return;
    }

    logger.debug(`Full context: ${JSON.stringify(context)}`);
};

function buildEmbedSummary(message: Message): string | null {
    if (!message.embeds?.length) {
        return null;
    }

    // Turn embeds into a compact text snapshot (all fields) so bot messages that
    // only contained embeds still make it into the planner and follow-ups.
    const lines: string[] = [];
    let embedIndex = 1;

    for (const embed of message.embeds) {
        lines.push(`[Embed ${embedIndex}]`);
        if (embed.title) lines.push(`Title: ${embed.title}`);
        if (embed.description) lines.push(`Description: ${embed.description}`);
        if (embed.author?.name) lines.push(`Author: ${embed.author.name}`);
        if (embed.url) lines.push(`URL: ${embed.url}`);
        if (embed.image?.url) lines.push(`Image: ${embed.image.url}`);
        if (embed.thumbnail?.url)
            lines.push(`Thumbnail: ${embed.thumbnail.url}`);
        if (embed.footer?.text) lines.push(`Footer: ${embed.footer.text}`);
        if (embed.provider?.name)
            lines.push(`Provider: ${embed.provider.name}`);
        if (embed.fields?.length) {
            for (const field of embed.fields) {
                lines.push(`${field.name}: ${field.value ?? ''}`);
            }
        }
        embedIndex += 1;
    }

    return lines.join('\n');
}

/**
 * Builds the prompt context passed to the Discord bot's chat-generation
 * pipeline.
 */
export class ContextBuilder {
    private readonly DEFAULT_CONTEXT_MESSAGES = 12;

    /**
     * Builds the message context for the given message
     * @param {Message} message - The message to build the context for
     * @returns {Promise<{ context: PromptMessage[] }>} The message context
     */
    public async buildMessageContext(
        message: Message,
        maxMessages: number = this.DEFAULT_CONTEXT_MESSAGES
    ): Promise<{ context: PromptMessage[] }> {
        logger.debug(
            `Building message context for message ID: ${message.id} (${message.content?.substring(0, 50)}${message.content?.length > 50 ? '...' : ''})`
        );

        // Get the message being replied to if this is a reply
        const repliedMessage = message.reference?.messageId
            ? await message.channel.messages
                  .fetch(message.reference.messageId)
                  .catch((error) => {
                      logger.debug(
                          `Failed to fetch replied message ${message.reference?.messageId}: ${error.message}`
                      );
                      return null;
                  })
            : null;

        logger.debug(
            `Is reply: ${!!repliedMessage}${repliedMessage ? ` (to message ID: ${repliedMessage.id})` : ''}`
        );

        // Fetch messages before the current message
        const recentMessages = await message.channel.messages.fetch({
            limit: repliedMessage ? Math.floor(maxMessages / 2) : maxMessages, // Use half the messages if this is a reply, as we'll fetch more messages before the replied-to message
            before: message.id,
        });
        logger.debug(
            `Fetched ${recentMessages.size} recent messages before current message`
        );

        // If this is a reply, fetch messages before the replied message as well
        let contextMessages = new Map(recentMessages);
        if (repliedMessage) {
            const messagesBeforeReply = await message.channel.messages.fetch({
                limit: maxMessages,
                before: repliedMessage.id,
            });
            logger.debug(
                `Fetched ${messagesBeforeReply.size} messages before replied message`
            );

            // Merge both message collections, removing duplicates
            const beforeMergeSize = contextMessages.size;
            messagesBeforeReply.forEach((msg, id) => {
                if (!contextMessages.has(id)) {
                    contextMessages.set(id, msg);
                }
            });
            logger.debug(
                `Added ${contextMessages.size - beforeMergeSize} new messages from before replied message`
            );

            // Add the replied message if it's not already included
            if (!contextMessages.has(repliedMessage.id)) {
                contextMessages.set(repliedMessage.id, repliedMessage);
                logger.debug(
                    `Added replied message to context: ${repliedMessage.id}`
                );
            }
        }

        // Build the message history
        let messageIndex = 0;
        let repliedMessageIndex = null;
        const history: PromptMessage[] = Array.from(contextMessages.values())
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .map((m) => {
                const isBot = m.author.id === message.client.user?.id;
                const displayName = m.member?.displayName || m.author.username;
                const timestamp = new Date(m.createdTimestamp)
                    .toISOString()
                    .replace(/T/, ' ')
                    .replace(/\..+/, '')
                    .slice(0, -3); // Trim to minutes
                let formattedMessage = `[${messageIndex++}] At ${timestamp} ${m.author.username}${displayName !== m.author.username ? `/${displayName}` : ''}${isBot ? ' (bot)' : ''} said: "${m.content}"`;

                // If this is the replied message, set the replied message index
                if (repliedMessage && m.id === repliedMessage.id) {
                    repliedMessageIndex = messageIndex;
                }

                const embedSummary = buildEmbedSummary(m);
                if (!isBot) {
                    if (embedSummary) {
                        formattedMessage += `\n${embedSummary}`;
                    }
                }

                let assistantContent = m.content?.trim() ?? '';
                if (isBot) {
                    // Keep the bot’s preamble and splice in any embed summary so
                    // embed-only replies don’t vanish from context.
                    const assistantPreamble = `[${messageIndex - 1}] At ${timestamp} ${m.author.username}${displayName !== m.author.username ? `/${displayName}` : ''} (bot) said:`;
                    if (embedSummary) {
                        assistantContent = assistantContent
                            ? `${assistantContent}\n${assistantPreamble}\n${embedSummary}`
                            : `${assistantPreamble}\n${embedSummary}`;
                    }
                    if (!assistantContent) {
                        assistantContent = `${assistantPreamble} Assistant response contained only embeds.`;
                    } else if (
                        !assistantContent.startsWith(assistantPreamble)
                    ) {
                        assistantContent = `${assistantPreamble} ${assistantContent}`;
                    }
                }

                return {
                    role: isBot ? 'assistant' : ('user' as const),
                    content: isBot ? assistantContent : formattedMessage,
                };
            });

        const contextHistory = [...history];

        // Add the current message
        contextHistory.push({
            role: 'user',
            content: `${message.member?.displayName || message.author.username} said: "${message.content}" ${repliedMessageIndex ? ` (Replying to message ${repliedMessageIndex - 1})` : ''}`,
        });

        // Build the final context
        const systemPrompt = [
            renderPrompt('conversation.shared.system').content,
            renderPrompt('discord.chat.system').content,
        ].join('\n\n');
        const context: PromptMessage[] = [
            { role: 'system', content: systemPrompt },
            ...contextHistory,
        ];
        logContextIfVerbose(context);

        logger.debug(
            `Final context built with ${context.length} messages (${contextHistory.length} history + 1 system)`
        );
        return { context };
    }
}
