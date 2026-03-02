/**
 * @description: In-memory state manager tracking recent messages and metrics per channel for engagement decisions.
 * @footnote-scope: core
 * @footnote-module: ChannelContextManager
 * @footnote-risk: high - Memory leaks if eviction fails; state inconsistency if concurrent updates race. Excessive reduction/manipulation/deletion of context can lead to poor decision making.
 * @footnote-ethics: high - Respects Discord ToS by keeping all data volatile. Exposing PII to users outside of proper channel scope can lead to privacy violations.
 */

import { Message } from 'discord.js';
import { logger } from '../utils/logger.js';

/**
 * Stored message for the channel context manager
 * @interface StoredMessage
 * @property {string} id - The ID of the message
 * @property {string} authorId - The ID of the author of the message
 * @property {string} authorUsername - The username of the author of the message
 * @property {string} content - The content of the message
 * @property {number} timestamp - The timestamp of the message
 * @property {boolean} isBot - Whether the message is from a bot
 * @property {number} tokenEstimate - The estimated number of tokens in the message
 */
export interface StoredMessage {
    id: string;
    authorId: string;
    authorUsername: string;
    content: string;
    timestamp: number;
    isBot: boolean;
    tokenEstimate: number;
}

/**
 * Metrics for the channel context manager
 * @interface ChannelMetrics
 * @property {number} totalMessages - The total number of messages in the channel
 * @property {number} botMessages - The number of bot messages in the channel
 * @property {number} humanMessages - The number of human messages in the channel
 * @property {number} llmCalls - The number of LLM calls in the channel
 * @property {number} tokensUsed - The number of tokens used in the channel
 * @property {number} usdEstimated - The estimated cost of the LLM usage in the channel
 * @property {number} lastEngagementScore - The last engagement score for the channel
 * @property {number} lastActivity - The last activity timestamp for the channel
 * @property {string[]} flags - The flags for the channel
 */
export interface ChannelMetrics {
    totalMessages: number;
    botMessages: number;
    humanMessages: number;
    llmCalls: number;
    tokensUsed: number;
    usdEstimated: number;
    lastEngagementScore: number;
    lastActivity: number;
    flags: string[];
}

/**
 * State for the channel context manager
 * @interface ChannelState
 * @property {StoredMessage[]} messages - The messages in the channel
 * @property {ChannelMetrics} metrics - The metrics for the channel
 * @property {number} lastEviction - The last time the channel was evicted
 */
interface ChannelState {
    messages: StoredMessage[];
    metrics: ChannelMetrics;
    lastEviction: number;
}

/**
 * Configuration for the channel context manager
 * @interface ChannelContextConfig
 * @property {boolean} enabled - Whether the channel context manager is enabled
 * @property {number} maxMessagesPerChannel - The maximum number of messages to store per channel
 * @property {number} messageRetentionMs - The retention time for messages in the channel
 * @property {number} evictionIntervalMs - The interval at which to evict expired messages
 */
export interface ChannelContextConfig {
    enabled: boolean;
    maxMessagesPerChannel: number;
    messageRetentionMs: number;
    evictionIntervalMs: number;
}

/**
 * In-memory state manager tracking recent messages and metrics per channel for engagement decisions.
 * @class ChannelContextManager
 * @param {ChannelContextConfig} config - The configuration for the channel context manager
 * @property {Map<string, ChannelState>} channelStates - The state of each channel
 * @property {ChannelContextConfig} config - The configuration for the channel context manager
 * @property {number} lastGlobalEviction - The last time the global eviction was run
 * @method recordMessage - Record a message in the channel context manager
 * @method getRecentMessages - Get the recent messages from the channel context manager
 * @method getMetrics - Get the metrics from the channel context manager
 */
export class ChannelContextManager {
    private readonly channelStates = new Map<string, ChannelState>();
    private readonly config: ChannelContextConfig;
    private lastGlobalEviction: number;

    constructor(config: ChannelContextConfig) {
        this.config = config;
        this.lastGlobalEviction = Date.now();
        logger.debug(
            JSON.stringify({
                event: 'context_manager_init',
                enabled: this.config.enabled,
                maxMessagesPerChannel: this.config.maxMessagesPerChannel,
                messageRetentionMs: this.config.messageRetentionMs,
                evictionIntervalMs: this.config.evictionIntervalMs,
            })
        );
    }

    /**
     * Record a message in the channel context manager
     * @param channelId - The ID of the channel the message is in
     * @param message - The message being recorded
     */
    public recordMessage(channelId: string, message: Message): void {
        try {
            if (!this.config.enabled) {
                return;
            }

            const storedMessage: StoredMessage = {
                id: message.id,
                authorId: message.author.id,
                authorUsername: message.author.username ?? 'unknown',
                content: message.content ?? '',
                timestamp: message.createdTimestamp,
                isBot: message.author.bot,
                tokenEstimate: this.estimateTokenCount(message.content ?? ''),
            };

            const state = this.getOrCreateState(channelId);
            state.messages.push(storedMessage);

            if (state.messages.length > this.config.maxMessagesPerChannel) {
                state.messages.splice(
                    0,
                    state.messages.length - this.config.maxMessagesPerChannel
                );
            }

            state.metrics.totalMessages += 1;
            if (storedMessage.isBot) {
                state.metrics.botMessages += 1;
            } else {
                state.metrics.humanMessages += 1;
            }
            state.metrics.lastActivity = storedMessage.timestamp;

            logger.debug(
                JSON.stringify({
                    event: 'context_message_recorded',
                    channelId,
                    messageId: storedMessage.id,
                    bufferSize: state.messages.length,
                })
            );

            const now = Date.now();
            if (
                now - this.lastGlobalEviction >=
                this.config.evictionIntervalMs
            ) {
                this.evictExpired();
            }
        } catch (error) {
            logger.error(
                `ChannelContextManager recordMessage failed for ${channelId}: ${(error as Error)?.message ?? error}`
            );
        }
    }

    /**
     * Get the recent messages from the channel context manager
     * @param channelId - The ID of the channel to get the recent messages from
     * @param count - The number of messages to get
     * @returns The recent messages from the channel
     */
    public getRecentMessages(
        channelId: string,
        count?: number
    ): StoredMessage[] {
        try {
            if (!this.config.enabled) {
                return [];
            }

            const state = this.channelStates.get(channelId);
            if (!state) {
                return [];
            }

            const messages =
                typeof count === 'number'
                    ? state.messages.slice(-Math.max(0, count))
                    : state.messages;

            return messages.map((message) => ({ ...message }));
        } catch (error) {
            logger.error(
                `ChannelContextManager getRecentMessages failed for ${channelId}: ${(error as Error)?.message ?? error}`
            );
            return [];
        }
    }

    /**
     * Get the metrics from the channel context manager
     * @param channelId - The ID of the channel to get the metrics from
     * @returns The metrics from the channel
     */
    public getMetrics(channelId: string): ChannelMetrics | null {
        try {
            if (!this.config.enabled) {
                return null;
            }

            const state = this.channelStates.get(channelId);
            if (!state) {
                return null;
            }

            const { metrics } = state;
            return {
                ...metrics,
                flags: [...metrics.flags],
            };
        } catch (error) {
            logger.error(
                `ChannelContextManager getMetrics failed for ${channelId}: ${(error as Error)?.message ?? error}`
            );
            return null;
        }
    }

    /**
     * Record the LLM usage for the channel
     * @param channelId - The ID of the channel the LLM usage is for
     * @param model - The model used for the LLM usage
     * @param tokensIn - The number of tokens input to the LLM
     * @param tokensOut - The number of tokens output from the LLM
     * @param usdCost - The cost of the LLM usage in USD
     */
    public recordLLMUsage(
        channelId: string,
        model: string,
        tokensIn: number,
        tokensOut: number,
        usdCost: number
    ): void {
        try {
            if (!this.config.enabled) {
                return;
            }

            const state = this.getOrCreateState(channelId);
            state.metrics.llmCalls += 1;
            state.metrics.tokensUsed +=
                Math.max(0, tokensIn) + Math.max(0, tokensOut);
            state.metrics.usdEstimated += Math.max(0, usdCost);
            state.metrics.lastActivity = Date.now();

            logger.debug(
                JSON.stringify({
                    event: 'context_llm_usage',
                    channelId,
                    model,
                    tokensIn,
                    tokensOut,
                    usdCost,
                    cumulativeUsd: state.metrics.usdEstimated,
                })
            );
        } catch (error) {
            logger.error(
                `ChannelContextManager recordLLMUsage failed for ${channelId}: ${(error as Error)?.message ?? error}`
            );
        }
    }

    /**
     * Update the engagement score for the channel
     * @param channelId - The ID of the channel to update the engagement score for
     * @param score - The new engagement score
     */
    public updateEngagementScore(channelId: string, score: number): void {
        try {
            if (!this.config.enabled) {
                return;
            }

            const state = this.getOrCreateState(channelId);
            state.metrics.lastEngagementScore = score;
        } catch (error) {
            logger.error(
                `ChannelContextManager updateEngagementScore failed for ${channelId}: ${(error as Error)?.message ?? error}`
            );
        }
    }

    /**
     * Set a flag for the channel
     * @param channelId - The ID of the channel to set the flag for
     * @param flag - The flag to set
     */
    public setFlag(channelId: string, flag: string): void {
        try {
            if (!this.config.enabled) {
                return;
            }

            const state = this.getOrCreateState(channelId);
            if (!state.metrics.flags.includes(flag)) {
                state.metrics.flags.push(flag);
            }
        } catch (error) {
            logger.error(
                `ChannelContextManager setFlag failed for ${channelId}: ${(error as Error)?.message ?? error}`
            );
        }
    }

    /**
     * Clear a flag for the channel
     * @param channelId - The ID of the channel to clear the flag for
     * @param flag - The flag to clear
     */
    public clearFlag(channelId: string, flag: string): void {
        try {
            if (!this.config.enabled) {
                return;
            }

            const state = this.channelStates.get(channelId);
            if (!state) {
                return;
            }

            state.metrics.flags = state.metrics.flags.filter(
                (existing) => existing !== flag
            );
        } catch (error) {
            logger.error(
                `ChannelContextManager clearFlag failed for ${channelId}: ${(error as Error)?.message ?? error}`
            );
        }
    }

    /**
     * Reset the channel context manager for a channel
     * @param channelId - The ID of the channel to reset the context manager for
     */
    public resetChannel(channelId: string): void {
        try {
            if (!this.config.enabled) {
                return;
            }

            this.channelStates.delete(channelId);
            logger.debug(
                JSON.stringify({
                    event: 'context_channel_reset',
                    channelId,
                })
            );
        } catch (error) {
            logger.error(
                `ChannelContextManager resetChannel failed for ${channelId}: ${(error as Error)?.message ?? error}`
            );
        }
    }

    /**
     * Evict expired messages from the channel context manager
     */
    public evictExpired(): void {
        try {
            if (!this.config.enabled) {
                return;
            }

            const now = Date.now();
            let channelsEvicted = 0;
            let messagesEvicted = 0;

            for (const [channelId, state] of this.channelStates.entries()) {
                const beforeCount = state.messages.length;
                state.messages = state.messages.filter(
                    (message) =>
                        now - message.timestamp <=
                        this.config.messageRetentionMs
                );
                messagesEvicted += beforeCount - state.messages.length;
                state.lastEviction = now;

                if (
                    state.messages.length === 0 &&
                    now - state.metrics.lastActivity >
                        this.config.messageRetentionMs
                ) {
                    this.channelStates.delete(channelId);
                    channelsEvicted += 1;
                }
            }

            this.lastGlobalEviction = now;

            logger.debug(
                JSON.stringify({
                    event: 'context_eviction',
                    channelsEvicted,
                    messagesEvicted,
                })
            );
        } catch (error) {
            logger.error(
                `ChannelContextManager evictExpired failed: ${(error as Error)?.message ?? error}`
            );
        }
    }

    /**
     * Get the state summary for the channel context manager
     * @returns The state summary for the channel context manager
     */
    public getStateSummary(): {
        channelCount: number;
        totalMessages: number;
        totalCost: number;
    } {
        try {
            if (!this.config.enabled) {
                return { channelCount: 0, totalMessages: 0, totalCost: 0 };
            }

            let channelCount = 0;
            let totalMessages = 0;
            let totalCost = 0;

            for (const state of this.channelStates.values()) {
                channelCount += 1;
                totalMessages += state.metrics.totalMessages;
                totalCost += state.metrics.usdEstimated;
            }

            return { channelCount, totalMessages, totalCost };
        } catch (error) {
            logger.error(
                `ChannelContextManager getStateSummary failed: ${(error as Error)?.message ?? error}`
            );
            return { channelCount: 0, totalMessages: 0, totalCost: 0 };
        }
    }

    /**
     * Get the state for a channel, or create it if it doesn't exist
     * @param channelId - The ID of the channel to get the state for
     * @returns The state for the channel
     */
    private getOrCreateState(channelId: string): ChannelState {
        let state = this.channelStates.get(channelId);
        if (!state) {
            state = {
                messages: [],
                metrics: {
                    totalMessages: 0,
                    botMessages: 0,
                    humanMessages: 0,
                    llmCalls: 0,
                    tokensUsed: 0,
                    usdEstimated: 0,
                    lastEngagementScore: 0,
                    lastActivity: Date.now(),
                    flags: [],
                },
                lastEviction: Date.now(),
            };
            this.channelStates.set(channelId, state);
        }
        return state;
    }

    /**
     * Estimate the number of tokens in a message
     * @param content - The content of the message to estimate the tokens for
     * @returns The estimated number of tokens in the message
     */
    private estimateTokenCount(content: string): number {
        const roughEstimate = Math.ceil((content ?? '').length / 4);
        return Math.max(1, roughEstimate);
    }
}

