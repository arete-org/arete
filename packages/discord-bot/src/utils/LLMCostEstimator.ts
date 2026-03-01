/**
 * @footnote-module: LLMCostEstimator
 * @footnote-risk: moderate
 * @footnote-ethics: high
 * @footnote-scope: core
 *
 * @description: Tracks OpenAI API usage and costs per channel/guild/global for budget enforcement and transparency
 *
 * @impact
 * Risk: Memory leaks if not properly managed; state inconsistency if concurrent updates race.
 * Ethics: Provides cost transparency and enables budget controls; high-importance for responsible AI resource consumption.
 */

import { logger, logLLMCostSummary, type LLMCostTotals } from './logger.js';
import { formatUsd } from './pricing.js';
import type { ModelCostBreakdown, CostStatistics } from './pricing.js';
import type { ChannelContextManager } from '../state/ChannelContextManager.js';

/**
 * @footnote-logger: llmCostEstimator
 *
 * @logs
 * LLM cost breakdowns, channel/guild totals, global totals, and context manager usage
 *
 * @impact
 * Risk: Memory leaks if not properly managed; state inconsistency if concurrent updates race.
 * Ethics: Provides cost transparency and enables budget controls; high-importance for responsible AI resource consumption.
 */
const costLogger = logger.child({ module: 'llmCostEstimator' });

/**
 * Configuration for the LLMCostEstimator.
 * The estimator is enabled by default in the environment variables, though we offer a way to disable it.
 * @interface LLMCostEstimatorConfig
 * @property {boolean} enabled - Whether the cost estimator is enabled
 * @property {ChannelContextManager | null} contextManager - The context manager to use for recording LLM usage
 */
export interface LLMCostEstimatorConfig {
    enabled: boolean;
    contextManager: ChannelContextManager | null;
}

/**
 * Totals for a specific scope (channel or guild).
 * @interface ScopeTotals
 * @property {number} calls - The number of calls made
 * @property {number} tokensIn - The number of input tokens used
 * @property {number} tokensOut - The number of output tokens used
 * @property {number} costUsd - The cost in USD
 */
interface ScopeTotals {
    calls: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
}

/**
 * Tracks cumulative LLM costs for the current process.
 *
 */
export class LLMCostEstimator {
    private config: LLMCostEstimatorConfig;
    private globalTotals: CostStatistics;
    private channelTotals: Map<string, CostStatistics>;
    private guildTotals: Map<string, CostStatistics>;

    /**
     * Creates a new LLMCostEstimator instance with the provided configuration.
     * Initializes empty totals maps and sets up logging.
     * @param {LLMCostEstimatorConfig} config - Configuration object containing enabled flag and context manager reference
     */
    constructor(config: LLMCostEstimatorConfig) {
        this.config = { ...config };
        this.globalTotals = this.createEmptyTotals(true);
        this.channelTotals = new Map();
        this.guildTotals = new Map();

        costLogger.debug(
            `LLMCostEstimator initialized (enabled=${String(this.config.enabled)})`
        );
    }

    /**
     * Sets the ChannelContextManager reference for per-channel cost tracking.
     * Called by MessageCreate after the context manager is initialized.
     * @param contextManager - The ChannelContextManager instance to use
     */
    public setContextManager(
        contextManager: ChannelContextManager | null
    ): void {
        this.config.contextManager = contextManager;
        if (contextManager) {
            costLogger.debug(
                'LLMCostEstimator connected to ChannelContextManager'
            );
        } else {
            costLogger.debug(
                'LLMCostEstimator disconnected from ChannelContextManager'
            );
        }
    }

    /**
     * Records a cost breakdown and updates all relevant totals (global, channel, guild).
     * Also logs the cost event and updates the context manager if available.
     * @param {ModelCostBreakdown} breakdown - The cost breakdown to record
     */
    public recordCost(breakdown: ModelCostBreakdown): void {
        if (!this.config.enabled) {
            return;
        }

        try {
            this.updateTotals(this.globalTotals, breakdown);

            if (breakdown.channelId) {
                const totals = this.getOrCreateChannelTotals(
                    breakdown.channelId
                );
                this.updateTotals(totals, breakdown);
                this.updateTotalsForScope(
                    'byChannel',
                    breakdown.channelId,
                    this.globalTotals,
                    breakdown
                );
            }

            if (breakdown.guildId) {
                const totals = this.getOrCreateGuildTotals(breakdown.guildId);
                this.updateTotals(totals, breakdown);
                this.updateTotalsForScope(
                    'byGuild',
                    breakdown.guildId,
                    this.globalTotals,
                    breakdown
                );
            }

            if (this.config.contextManager && breakdown.channelId) {
                try {
                    // Use the same channel key format as MessageCreate: ${guildId ?? 'DM'}:${channelId}
                    const channelKey = breakdown.guildId
                        ? `${breakdown.guildId}:${breakdown.channelId}`
                        : `DM:${breakdown.channelId}`;

                    this.config.contextManager.recordLLMUsage(
                        channelKey,
                        breakdown.model,
                        breakdown.inputTokens,
                        breakdown.outputTokens,
                        breakdown.totalCost
                    );
                } catch (contextError) {
                    costLogger.error(
                        `Failed to record LLM usage in ChannelContextManager for channel ${breakdown.channelId}: ${
                            (contextError as Error)?.message ?? contextError
                        }`
                    );
                }
            }

            costLogger.info(
                JSON.stringify({
                    event: 'llm_cost',
                    requestId: breakdown.requestId,
                    channelId: breakdown.channelId ?? null,
                    guildId: breakdown.guildId ?? null,
                    model: breakdown.model,
                    totalCostUsd: Number(breakdown.totalCost.toFixed(6)),
                    budgetRemainingUsd: null, // TODO: Populate from channel/guild/global budget once Phase 3 budget sources are wired
                    totalCostFormatted: formatUsd(breakdown.totalCost, 6),
                    cumulativeGlobalUsd: Number(
                        this.globalTotals.totalCostUsd.toFixed(6)
                    ),
                    timestamp: breakdown.timestamp,
                })
            );
        } catch (error) {
            costLogger.error(
                `Cost estimator failed to record breakdown for model ${breakdown.model}: ${(error as Error)?.message ?? error}`
            );
        }
    }

    /**
     * Returns a deep copy of the cumulative totals for the global scope.
     * @returns {CostStatistics} A cloned copy of the cumulative totals for the global scope
     */
    public getGlobalTotals(): CostStatistics {
        try {
            return this.cloneTotals(this.globalTotals);
        } catch (error) {
            costLogger.error(
                `Failed to clone global totals: ${(error as Error)?.message ?? error}`
            );
            return this.createEmptyTotals(true);
        }
    }

    /**
     * Returns a deep copy of the cumulative totals for a specific channel.
     * @param {string} channelId - The ID of the channel to get totals for
     * @returns {CostStatistics | null} A cloned copy of the channel totals, or null if not found
     */
    public getChannelTotals(channelId: string): CostStatistics | null {
        try {
            const totals = this.channelTotals.get(channelId);
            if (totals) {
                costLogger.debug(
                    `Retrieved channel totals for ${channelId} (${totals.totalCalls} calls, $${totals.totalCostUsd.toFixed(4)} total)`
                );
            }
            return totals ? this.cloneTotals(totals) : null;
        } catch (error) {
            costLogger.error(
                `Failed to clone channel totals for ${channelId}: ${(error as Error)?.message ?? error}`
            );
            return null;
        }
    }

    /**
     * Returns a deep copy of the cumulative totals for a specific guild.
     * @param {string} guildId - The ID of the guild to get totals for
     * @returns {CostStatistics | null} A cloned copy of the guild totals, or null if not found
     */
    public getGuildTotals(guildId: string): CostStatistics | null {
        try {
            const totals = this.guildTotals.get(guildId);
            if (totals) {
                costLogger.debug(
                    `Retrieved guild totals for ${guildId} (${totals.totalCalls} calls, $${totals.totalCostUsd.toFixed(4)} total)`
                );
            }
            return totals ? this.cloneTotals(totals) : null;
        } catch (error) {
            costLogger.error(
                `Failed to clone guild totals for ${guildId}: ${(error as Error)?.message ?? error}`
            );
            return null;
        }
    }

    /**
     * Resets all global cumulative totals to zero and logs the reset event.
     */
    public resetGlobalTotals(): void {
        try {
            this.globalTotals = this.createEmptyTotals(true);
            costLogger.info(
                JSON.stringify({ event: 'llm_cost_reset', scope: 'global' })
            );
        } catch (error) {
            costLogger.error(
                `Failed to reset global totals: ${(error as Error)?.message ?? error}`
            );
        }
    }

    /**
     * Resets cumulative totals for a specific channel and removes it from global scope tracking.
     * @param {string} channelId - The ID of the channel to reset totals for
     */
    public resetChannelTotals(channelId: string): void {
        try {
            this.channelTotals.delete(channelId);
            if (this.globalTotals.byChannel) {
                delete this.globalTotals.byChannel[channelId];
            }
            costLogger.info(
                JSON.stringify({
                    event: 'llm_cost_reset',
                    scope: 'channel',
                    channelId,
                })
            );
        } catch (error) {
            costLogger.error(
                `Failed to reset channel totals for ${channelId}: ${(error as Error)?.message ?? error}`
            );
        }
    }

    /**
     * Returns a lightweight summary of global totals suitable for logging.
     */
    public getSummaryTotals(): LLMCostTotals {
        return {
            totalCostUsd: this.globalTotals.totalCostUsd,
            totalCalls: this.globalTotals.totalCalls,
            totalTokensIn: this.globalTotals.totalTokensIn,
            totalTokensOut: this.globalTotals.totalTokensOut,
        };
    }

    /**
     * Logs the current LLM cost summary using the shared logger helper.
     */
    public logSummary(): void {
        logLLMCostSummary(() => this.getSummaryTotals());
    }

    /**
     * Gets existing channel totals or creates new ones if they don't exist.
     * @param {string} channelId - The ID of the channel
     * @returns {CostStatistics} The channel totals (existing or newly created)
     */
    private getOrCreateChannelTotals(channelId: string): CostStatistics {
        const existing = this.channelTotals.get(channelId);
        if (existing) {
            return existing;
        }

        const totals = this.createEmptyTotals();
        this.channelTotals.set(channelId, totals);
        costLogger.debug(
            `Created new channel totals for ${channelId} (total channels tracked: ${this.channelTotals.size})`
        );
        return totals;
    }

    /**
     * Gets existing guild totals or creates new ones if they don't exist.
     * @param {string} guildId - The ID of the guild
     * @returns {CostStatistics} The guild totals (existing or newly created)
     */
    private getOrCreateGuildTotals(guildId: string): CostStatistics {
        const existing = this.guildTotals.get(guildId);
        if (existing) {
            return existing;
        }

        const totals = this.createEmptyTotals();
        this.guildTotals.set(guildId, totals);
        costLogger.debug(
            `Created new guild totals for ${guildId} (total guilds tracked: ${this.guildTotals.size})`
        );
        return totals;
    }

    /**
     * Updates cumulative totals with a new cost breakdown.
     * Increments counters and adds costs for both overall totals and per-model breakdown.
     * @param {CostStatistics} totals - The totals object to update
     * @param {ModelCostBreakdown} breakdown - The cost breakdown to add
     */
    private updateTotals(
        totals: CostStatistics,
        breakdown: ModelCostBreakdown
    ): void {
        totals.totalCalls += 1;
        totals.totalTokensIn += breakdown.inputTokens;
        totals.totalTokensOut += breakdown.outputTokens;
        totals.totalCostUsd += breakdown.totalCost;

        const modelTotals = totals.byModel[breakdown.model] ?? {
            calls: 0,
            tokensIn: 0,
            tokensOut: 0,
            costUsd: 0,
        };

        modelTotals.calls += 1;
        modelTotals.tokensIn += breakdown.inputTokens;
        modelTotals.tokensOut += breakdown.outputTokens;
        modelTotals.costUsd += breakdown.totalCost;
        totals.byModel[breakdown.model] = modelTotals;
    }

    /**
     * Updates scope-specific totals (by channel or guild) within the global totals.
     * @param {'byChannel' | 'byGuild'} scope - The scope type to update
     * @param {string} id                     - The ID of the channel or guild
     * @param {CostStatistics} totals       - The cumulative totals object to update
     * @param {ModelCostBreakdown} breakdown       - The cost breakdown to add
     */
    private updateTotalsForScope(
        scope: 'byChannel' | 'byGuild',
        id: string,
        totals: CostStatistics,
        breakdown: ModelCostBreakdown
    ): void {
        if (!totals[scope]) {
            totals[scope] = {};
        }

        const scopeTotals: ScopeTotals = totals[scope]![id] ?? {
            calls: 0,
            tokensIn: 0,
            tokensOut: 0,
            costUsd: 0,
        };

        scopeTotals.calls += 1;
        scopeTotals.tokensIn += breakdown.inputTokens;
        scopeTotals.tokensOut += breakdown.outputTokens;
        scopeTotals.costUsd += breakdown.totalCost;

        totals[scope]![id] = scopeTotals;
    }

    /**
     * Creates a new empty CostStatistics object.
     * @param {boolean} includeScopes - Whether to include byChannel and byGuild scope objects
     * @returns {CostStatistics} A new empty totals object
     */
    private createEmptyTotals(includeScopes = false): CostStatistics {
        const totals: CostStatistics = {
            totalCalls: 0,
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCostUsd: 0,
            byModel: {},
        };

        if (includeScopes) {
            totals.byChannel = {};
            totals.byGuild = {};
        }

        return totals;
    }

    /**
     * Creates a deep copy of CostStatistics to prevent external mutation.
     * @param {CostStatistics} totals - The totals object to clone
     * @returns {CostStatistics} A deep copy of the totals object
     */
    private cloneTotals(totals: CostStatistics): CostStatistics {
        return {
            totalCalls: totals.totalCalls,
            totalTokensIn: totals.totalTokensIn,
            totalTokensOut: totals.totalTokensOut,
            totalCostUsd: totals.totalCostUsd,
            byModel: this.cloneScope(totals.byModel),
            byChannel: totals.byChannel
                ? this.cloneScope(totals.byChannel)
                : undefined,
            byGuild: totals.byGuild
                ? this.cloneScope(totals.byGuild)
                : undefined,
        };
    }

    /**
     * Creates a deep copy of a scope totals record (byChannel or byGuild).
     * @param {Record<string, ScopeTotals>} source - The scope record to clone
     * @returns {Record<string, ScopeTotals>} A deep copy of the scope record
     */
    private cloneScope(
        source: Record<string, ScopeTotals>
    ): Record<string, ScopeTotals> {
        return Object.entries(source).reduce<Record<string, ScopeTotals>>(
            (acc, [key, value]) => {
                acc[key] = { ...value };
                return acc;
            },
            {}
        );
    }
}

