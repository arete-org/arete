/**
 * @description: Weighted scoring system for engagement decisions during catchup events, analyzing context, cost, and conversation dynamics
 * @footnote-scope: core
 * @footnote-module: RealtimeEngagementFilter
 * @footnote-risk: high - Overly aggressive scoring causes spam; overly conservative scoring causes missed engagement.
 * @footnote-ethics: high - Controls bot's social awareness and respect for human conversations.
 */

import { Message } from 'discord.js';
import { logger } from '../utils/logger.js';
import { config } from '../utils/env.js';
import type { OpenAIService } from '../utils/openaiService.js';
import type { ChannelMetrics } from '../state/ChannelContextManager.js';
import type { CostStatistics } from '../utils/pricing.js';
import { TECHNICAL_KEYWORDS } from '../utils/CatchupFilter.js';

/**
 * @footnote-logger: realtimeEngagementFilter
 * @logs: Engagement decisions, scoring breakdowns, filter initialization, and error conditions.
 * @footnote-risk: high - Missing logs can hide scoring regressions that cause spammy or absent engagement.
 * @footnote-ethics: high - These records explain how the bot balances social awareness, restraint, and respect for human conversations.
 */
const engagementLogger = logger.child({ module: 'realtimeEngagementFilter' });

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

/**
 * Scoring weights for different engagement signals (0-1 range)
 * @type {Object}
 * @property {number} mention - Weight for direct mentions/questions (default 0.3)
 * @property {number} question - Weight for question marks and interrogatives (default 0.2)
 * @property {number} technical - Weight for technical keywords (default 0.15)
 * @property {number} humanActivity - Weight for recent human message ratio (default 0.15)
 * @property {number} costSaturation - Weight for cost velocity concerns (default 0.1, negative signal)
 * @property {number} botNoise - Weight for bot message ratio (default 0.05, negative signal)
 * @property {number} dmBoost - Multiplier for DM contexts (default 1.5)
 * @property {number} decay - Time decay factor for message recency (default 0.05)
 */
export interface EngagementWeights {
    mention: number;
    question: number;
    technical: number;
    humanActivity: number;
    costSaturation: number;
    botNoise: number;
    dmBoost: number;
    decay: number;
}

/**
 * Behavior preferences for engagement decisions
 * @type {Object}
 * @property {string} IGNORE_MODE - How to acknowledge when skipping: 'silent' or 'react'
 * @property {string} REACTION_EMOJI - Emoji to use when ignoreMode=react
 * @property {number} MIN_ENGAGE_THRESHOLD - Minimum score to engage (0-1)
 * @property {number} PROBABILISTIC_BAND_LOW - Lower bound of grey zone for LLM refinement
 * @property {number} PROBABILISTIC_BAND_HIGH - Upper bound of grey zone for LLM refinement
 * @property {boolean} ENABLE_LLM_REFINEMENT - Whether to use LLM to refine scores in grey zone
 */
export interface EngagementPreferences {
    ignoreMode: 'silent' | 'react';
    reactionEmoji: string;
    minEngageThreshold: number;
    probabilisticBand: [number, number];
    enableLLMRefinement: boolean;
}

/**
 * Final engagement decision with full breakdown
 * @type {Object}
 * @property {boolean} ENGAGE - Whether to proceed to planner
 * @property {number} SCORE - Computed engagement score (0-1)
 * @property {string} REASON - Human-readable explanation
 * @property {string[]} REASONS - Array of contributing factors
 * @property {Record<string, number>} BREAKDOWN - Per-signal score contributions
 */
export interface EngagementDecision {
    engage: boolean;
    score: number;
    reason: string;
    reasons: string[];
    breakdown: Record<string, number>;
}

/**
 * Input context for engagement decisions
 * @type {Object}
 * @property {Message} MESSAGE - Discord message object
 * @property {string} CHANNEL_KEY - Channel identifier
 * @property {Message[]} RECENT_MESSAGES - Recent message history
 * @property {ChannelMetrics | null} CHANNEL_METRICS - From ChannelContextManager
 * @property {CostStatistics | null} COST_TOTALS - From LLMCostEstimator
 */
export interface EngagementContext {
    message: Message;
    channelKey: string;
    recentMessages: Message[];
    channelMetrics: ChannelMetrics | null;
    costTotals: CostStatistics | null;
}

/**
 * Optional per-channel overrides for engagement configuration
 * @type {Object}
 * @property {Partial<EngagementWeights>} weights - Optional weight (0-1 range, higher = should engage more) overrides
 * @property {Partial<EngagementPreferences>} preferences - Optional preference (ignoreMode, reactionEmoji, minEngageThreshold, probabilisticBand, enableLLMRefinement) overrides
 */
export interface ChannelEngagementOverrides {
    weights?: Partial<EngagementWeights>;
    preferences?: Partial<EngagementPreferences>;
}

// ---------------------------------------------------------------------------
// Main Class
// ---------------------------------------------------------------------------

/**
 * Weighted scoring system for engagement decisions during catchup events.
 * Analyzes multiple signals to determine whether the bot should respond.
 * @type {Object}
 * @property {EngagementWeights} WEIGHTS - Scoring weights
 * @property {EngagementPreferences} PREFERENCES - Behavior preferences
 * @property {OpenAIService | undefined} OPENAI_SERVICE - Optional OpenAI service for LLM refinement
 */
export class RealtimeEngagementFilter {
    private readonly weights: EngagementWeights;
    private readonly preferences: EngagementPreferences;

    constructor(
        weights: EngagementWeights,
        preferences: EngagementPreferences,
        _openaiService?: OpenAIService
    ) {
        this.weights = weights;
        this.preferences = preferences;

        engagementLogger.debug('RealtimeEngagementFilter initialized', {
            weights: this.weights,
            preferences: this.preferences,
        });
    }

    /**
     * Main entry point for engagement decisions
     * How it works:
     * - Computes individual signal scores for all 6 engagement factors
     * - Applies configured weights to each signal and sums them
     * - Applies DM boost multiplier if message is in direct message context
     * - Optionally refines score with LLM if in probabilistic band (grey zone)
     * - Clamps final score to [0, 1] range
     * - Builds final decision with engage boolean, score, reasons, and breakdown
     * - Fails open on any errors to maintain pipeline stability
     *
     * Note: The decay weight is currently not applied to any signals. Future implementation
     * could apply time decay to question/technical/humanActivity signals based on message age.
     * // TODO: Apply decay weight to question/technical/humanActivity signals based on message age.
     * @param {EngagementContext} context - The context for the engagement decision
     * @param {ChannelEngagementOverrides} overrides - Optional per-channel overrides
     * @returns {Promise<EngagementDecision>} The engagement decision
     */
    public async decide(
        context: EngagementContext,
        overrides?: ChannelEngagementOverrides
    ): Promise<EngagementDecision> {
        try {
            // Merge overrides with defaults
            const effectiveWeights = { ...this.weights, ...overrides?.weights };
            const effectivePreferences = {
                ...this.preferences,
                ...overrides?.preferences,
            };

            const breakdown: Record<string, number> = {};

            // Compute individual signal scores
            breakdown.mention = this.scoreMention(context);
            breakdown.question = this.scoreQuestion(context);
            breakdown.technical = this.scoreTechnical(context);
            breakdown.humanActivity = this.scoreHumanActivity(context);
            breakdown.costSaturation = this.scoreCostSaturation(context);
            breakdown.botNoise = this.scoreBotNoise(context);

            // Calculate weighted score using effective (default or overridden) weights
            let score = 0;
            score += breakdown.mention * effectiveWeights.mention;
            score += breakdown.question * effectiveWeights.question;
            score += breakdown.technical * effectiveWeights.technical;
            score += breakdown.humanActivity * effectiveWeights.humanActivity;
            score += breakdown.costSaturation * effectiveWeights.costSaturation;
            score += breakdown.botNoise * effectiveWeights.botNoise;

            // Apply DM boost if applicable using effective weights
            score = this.applyDMBoost(score, context, effectiveWeights);

            // Optionally refine with LLM if in probabilistic band using effective preferences
            if (
                effectivePreferences.enableLLMRefinement &&
                score >= effectivePreferences.probabilisticBand[0] &&
                score <= effectivePreferences.probabilisticBand[1]
            ) {
                score = await this.refineLLM(score, context);
            }

            // Clamp to [0, 1] range
            score = Math.max(0, Math.min(1, score));

            // Build final decision using effective preferences
            return this.buildDecision(
                score,
                context,
                breakdown,
                effectivePreferences
            );
        } catch (error) {
            // Fail open - allow planner to run on errors
            engagementLogger.error(
                `RealtimeEngagementFilter error: ${(error as Error)?.message ?? error}`
            );
            return {
                engage: true,
                score: 0.5,
                reason: 'Filter error - allowing planner to run',
                reasons: ['error'],
                breakdown: {},
            };
        }
    }

    // ---------------------------------------------------------------------------
    // Private Scoring Methods
    // ---------------------------------------------------------------------------

    /**
     * Normalize a value to [0, 1] range
     */
    private normalizeScore(value: number, min: number, max: number): number {
        const clamped = Math.max(min, Math.min(max, value));
        return (clamped - min) / (max - min);
    }

    /**
     * Score based on direct mentions and replies
     * Normalized to [0, 1], ranging from low to high engagement.
     * How it works:
     * - If the message is a direct mention or reply to the bot, the score is 1.0.
     * - If the message is not a direct mention or reply to the bot, the score is 0.0.
     * - If the message includes the bot's plaintext username or configured mention names, the score is 0.9.
     * @param {EngagementContext} context - The context for the engagement decision
     * @returns {number} The score for the mention
     */
    private scoreMention(context: EngagementContext): number {
        const { message } = context;
        const botId = message.client.user?.id;
        const botUsername = message.client.user?.username ?? '';

        if (!botId) return 0;

        // Log bot username for debugging
        engagementLogger.debug('Bot username detected', {
            botUsername,
            channelId: context.channelKey,
        });

        // Check for @mentions
        if (message.mentions?.users?.has(botId)) {
            engagementLogger.debug('Direct mention detected', {
                channelId: context.channelKey,
                botId,
            });
            return 1.0;
        }

        // Check for reply to bot - use repliedUser first for reliable detection
        if (message.mentions?.repliedUser?.id === botId) {
            engagementLogger.debug('Reply to bot detected via repliedUser', {
                channelId: context.channelKey,
                botId,
            });
            return 1.0;
        }

        // Fallback: check recentMessages if repliedUser is unavailable
        if (
            message.reference?.messageId &&
            message.reference?.channelId === message.channelId
        ) {
            const recentMessages = context.recentMessages;
            const repliedMessage = recentMessages.find(
                (msg) => msg.id === message.reference?.messageId
            );
            if (repliedMessage?.author.id === botId) {
                engagementLogger.debug(
                    'Reply to bot detected via recentMessages fallback',
                    { channelId: context.channelKey, botId }
                );
                return 1.0;
            }
        }

        // Check for plaintext bot username and configurable mention names
        const messageContent = message.content.toLowerCase(); // Convert message content to lowercase for case-insensitive comparison
        const botNames = [
            botUsername.toLowerCase(),
            ...config.botMentionNames.map((name) => name.toLowerCase()),
        ]
            .filter((name) => name.length > 0)
            .filter((name, index, self) => self.indexOf(name) === index); // remove duplicates: users might enter varied casing of the same name, but we normalize to lowercase

        for (const name of botNames) {
            if (messageContent.includes(name)) {
                engagementLogger.debug(
                    'Plaintext username/nickname mention detected',
                    {
                        channelId: context.channelKey,
                        detectedName: name,
                        botUsername,
                        configuredNames: config.botMentionNames,
                        messageContent: message.content,
                    }
                );
                return 0.9;
            }
        }

        return 0.0;
    }

    /**
     * Score based on question marks and interrogatives (words that indicate a question)
     * Normalized to [0, 1], ranging from low to high engagement.
     * How it works:
     * - If the message contains a question mark, the score is 0.2 per mark.
     * - If the message contains an interrogative word (including contractions), the score is 0.3.
     * - If the message contains a common question phrase, the score is 0.4.
     * - If the message does not contain any question indicators, the score is 0.0.
     * @param {EngagementContext} context - The context for the engagement decision
     * @returns {number} The score for the question
     */
    private scoreQuestion(context: EngagementContext): number {
        const content = context.message.content ?? '';
        if (!content) return 0;

        const lower = content.toLowerCase();
        let score = 0;

        // Count question marks
        const questionMarks = (content.match(/\?/g) || []).length;
        score += Math.min(0.5, questionMarks * 0.2);

        // Check for interrogative words (including contractions)
        const interrogatives =
            /\b(who|what|where|when|why|how|can|could|should|would|is|are|do|does|did|will|would|have|has|had|whats|wheres|whens|whys|hows|whos)\b/;
        if (interrogatives.test(lower)) {
            score += 0.3;
        }

        // Check for common question phrases
        const questionPhrases =
            /\b(whats up|how are you|how is it|how goes|what about|how about|what do you|how do you|can you|could you|would you|should you|will you|do you|are you|is it|was it|were you|have you|has it|had you)\b/;
        if (questionPhrases.test(lower)) {
            score += 0.4; // Higher score for complete question phrases
        }

        return this.normalizeScore(score, 0, 1);
    }

    /**
     * Score based on technical keywords
     * Normalized to [0, 1], ranging from low to high engagement.
     * How it works:
     * - If the message contains a technical keyword, the score is 0.2.
     * - If the message does not contain a technical keyword, the score is 0.0.
     * @param {EngagementContext} context - The context for the engagement decision
     * @returns {number} The score for the technical keywords
     */
    private scoreTechnical(context: EngagementContext): number {
        const content = context.message.content ?? '';
        if (!content) return 0;

        const lower = content.toLowerCase();
        const foundKeywords = TECHNICAL_KEYWORDS.filter((keyword) =>
            lower.includes(keyword)
        );

        return Math.min(1.0, foundKeywords.length / TECHNICAL_KEYWORDS.length);
    }

    /**
     * Score based on recent human activity ratio
     * Normalized to [0, 1], ranging from low to high engagement.
     * How it works:
     * - Calculates the ratio of human messages to total messages in recent history
     * - Higher human activity (more human messages) = higher engagement score
     * - If no channel metrics available, returns neutral score of 0.5
     * - Pure human conversation gets score of 1.0, pure bot conversation gets 0.0
     * @param {EngagementContext} context - The context for the engagement decision
     * @returns {number} The score for the human activity
     */
    private scoreHumanActivity(context: EngagementContext): number {
        const { channelMetrics } = context;
        if (!channelMetrics || channelMetrics.totalMessages === 0) {
            return 0.5; // Neutral score if no data
        }

        // Calculate human messages as total minus bot messages (some channels may not have botMessages, so we need to handle this gracefully)
        const humanMessages =
            channelMetrics.totalMessages - channelMetrics.botMessages;
        const humanRatio = humanMessages / channelMetrics.totalMessages;
        return this.normalizeScore(humanRatio, 0, 1);
    }

    /**
     * Score based on cost saturation (the bot is spending too much money too quickly)
     * Normalized to [0, 1], ranging from low to high engagement.
     * How it works:
     * - Calculates cost velocity (USD spent per minute) over a 5-minute window
     * - Estimates recent cost as 10% of total channel cost
     * - Higher cost velocity = higher saturation = lower engagement score (inverted signal)
     * - Normalizes around $0.10/minute threshold
     * - If no cost data available, returns 0.0 (no saturation)
     * @param {EngagementContext} context - The context for the engagement decision
     * @returns {number} The score for the cost saturation
     */
    private scoreCostSaturation(context: EngagementContext): number {
        const { costTotals, channelMetrics } = context;
        if (!costTotals || !channelMetrics || !channelMetrics.lastActivity) {
            return 0.0; // No saturation if no data
        }

        // Calculate cost velocity (USD per minute) over recent window
        // const _now = Date.now();
        const timeWindowMs = 5 * 60 * 1000; // 5 minutes
        const timeWindowMinutes = timeWindowMs / (1000 * 60);

        // Estimate recent cost based on total cost and activity
        // TODO: Scale by time since last engagement or number of planner calls for more realistic feedback
        const recentCost = costTotals.totalCostUsd * 0.1; // Assume 10% is recent
        const costVelocity = recentCost / timeWindowMinutes;

        // Higher cost velocity = higher saturation = lower engagement
        const saturationScore = Math.min(1.0, costVelocity / 0.1); // Normalize around $0.10/minute
        const finalScore = 1.0 - saturationScore; // Invert to make it negative signal

        // Log high cost saturation for monitoring
        if (saturationScore > 0.7) {
            engagementLogger.warn('High cost saturation detected', {
                channelId: context.channelKey,
                costVelocity,
                saturationScore,
                finalScore,
            });
        }

        return finalScore;
    }

    /**
     * Score based on bot noise ratio (negative signal)
     * Normalized to [0, 1], ranging from low to high engagement.
     * How it works:
     * - Calculates the ratio of bot messages to total messages in recent history
     * - Higher bot noise (more bot messages) = lower engagement score (inverted signal)
     * - Pure human conversation gets score of 1.0, pure bot conversation gets 0.0
     * - If no channel metrics available, returns 0.0 (no noise)
     * - This prevents the bot from engaging in bot-dominated conversations
     * @param {EngagementContext} context - The context for the engagement decision
     * @returns {number} The score for the bot noise
     */
    private scoreBotNoise(context: EngagementContext): number {
        const { channelMetrics } = context;
        if (!channelMetrics || channelMetrics.totalMessages === 0) {
            return 0.0; // No noise if no data
        }

        const botRatio =
            channelMetrics.botMessages / channelMetrics.totalMessages;
        const finalScore = 1.0 - botRatio; // Invert to make it negative signal

        // Log high bot noise for monitoring
        if (botRatio > 0.7) {
            engagementLogger.warn('High bot noise detected', {
                channelId: context.channelKey,
                botRatio,
                totalMessages: channelMetrics.totalMessages,
                botMessages: channelMetrics.botMessages,
                finalScore,
            });
        }

        return finalScore;
    }

    /**
     * Apply DM boost multiplier
     * How it works:
     * - Checks if the message is in a direct message (DM) context (guildId is null)
     * - If it's a DM, multiplies the score by the DM_BOOST factor (default 1.5x)
     * - Clamps the result to maximum 1.0 to prevent score overflow
     * - DMs are considered more personal and warrant higher engagement
     * @param {number} score - The score to apply the DM boost to
     * @param {EngagementContext} context - The context for the engagement decision
     * @param {EngagementWeights} weights - The weights to use for DM boost
     * @returns {number} The score with the DM boost applied
     */
    private applyDMBoost(
        score: number,
        context: EngagementContext,
        weights: EngagementWeights
    ): number {
        if (context.message.guildId === null) {
            // This is a DM
            return Math.min(1.0, score * weights.dmBoost);
        }
        return score;
    }

    /**
     * Stub for future LLM refinement in "gray zone" (scores around 0.5, where the bot is unsure whether to engage or not)
     * How it works:
     * - Currently disabled and just returns the original score unchanged
     * - Future implementation will make lightweight LLM calls to refine scores
     * - Only called when score falls in the probabilistic band (gray zone)
     * - Will help with edge cases where heuristics are uncertain
     * - Expected output contract: returns a float in range [0, 1]
     * @param {number} score - The score to refine
     * @param {EngagementContext} context - The context for the engagement decision
     * @returns {Promise<number>} The refined score
     */
    private async refineLLM(
        score: number,
        _context: EngagementContext
    ): Promise<number> {
        engagementLogger.debug(
            'LLM refinement disabled - returning original score'
        );
        return score;
    }

    /**
     * Build final engagement decision
     * How it works:
     * - Compares final score against minimum engagement threshold (default 0.5)
     * - Builds reasons array from significant signal contributions
     * - Generates human-readable explanation combining threshold result with reasons
     * - Returns complete decision object with engage boolean, score, reason, and breakdown
     * - Used by MessageCreate to determine whether to proceed to planner or skip
     * @param {number} score - The score to build the decision from
     * @param {EngagementContext} context - The context for the engagement decision
     * @param {Record<string, number>} breakdown - The breakdown of the score
     * @param {EngagementPreferences} preferences - The preferences to use for decision
     * @returns {EngagementDecision} The engagement decision
     */
    private buildDecision(
        score: number,
        context: EngagementContext,
        breakdown: Record<string, number>,
        preferences: EngagementPreferences
    ): EngagementDecision {
        const engage = score >= preferences.minEngageThreshold;

        // Build reasons array from significant contributions
        // TODO: Consider deriving thresholds from weights rather than fixed constants
        const reasons: string[] = [];
        if (breakdown.mention > 0.5) reasons.push('mention');
        if (breakdown.question > 0.3) reasons.push('question');
        if (breakdown.technical > 0.2) reasons.push('technical');
        if (breakdown.humanActivity > 0.7) reasons.push('human_activity');
        if (breakdown.costSaturation > 0.7) reasons.push('low_cost_saturation');
        if (breakdown.botNoise > 0.7) reasons.push('low_bot_noise');
        if (context.message.guildId === null) reasons.push('dm_context');

        // Generate human-readable reason
        let reason = engage
            ? 'Engagement threshold met'
            : 'Engagement threshold not met';
        if (reasons.length > 0) {
            reason += ` (${reasons.join(', ')})`;
        }

        const decision = {
            engage,
            score,
            reason,
            reasons,
            breakdown,
        };

        // Log computed score and breakdown for debugging
        engagementLogger.debug('Engagement decision computed', {
            channelId: context.channelKey,
            score: decision.score,
            engage: decision.engage,
            threshold: preferences.minEngageThreshold,
            thresholdMet: decision.score >= preferences.minEngageThreshold,
            reasons: decision.reasons,
            breakdown: decision.breakdown,
            messageContent:
                context.message.content?.substring(0, 100) +
                (context.message.content?.length > 100 ? '...' : ''),
            messageAuthor: context.message.author.username,
            messageId: context.message.id,
        });

        return decision;
    }
}

