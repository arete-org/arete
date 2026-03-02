/**
 * @description: Tracks image generation token budgets and refresh cadence.
 * @footnote-scope: utility
 * @footnote-module: ImageTokenManager
 * @footnote-risk: medium - Token miscounts can skew rate limiting or cost controls.
 * @footnote-ethics: low - Token tracking does not process user content directly.
 */
import { logger } from './logger.js';
import {
    getImageModelTokenMultiplier,
    imageConfig,
} from '../config/imageConfig.js';
import type {
    ImageQualityType,
    ImageRenderModel,
} from '../commands/image/types.js';

/**
 * Represents the configurable settings for a token bucket. The manager keeps
 * everything in memory for now, but the abstraction makes it easy to swap in a
 * different persistence layer once we start tracking additional modalities.
 */
interface UsageTokenManagerOptions {
    tokensPerInterval: number;
    intervalMs: number;
    namespace?: string;
}

interface TokenBucketState {
    tokens: number;
    nextRefreshAt: number;
}

export interface TokenSnapshot {
    tokens: number;
    nextRefreshAt: number;
    refreshInSeconds: number;
}

export interface TokenSpendResult extends TokenSnapshot {
    allowed: boolean;
    cost: number;
    remainingTokens: number;
    neededTokens?: number;
}

/**
 * Lightweight token bucket manager that can service multiple feature scopes.
 * We only persist in memory today, but callers receive structured state so we
 * can later serialise to Redis or a database without touching call sites.
 */
export class UsageTokenManager {
    private readonly buckets = new Map<string, TokenBucketState>();

    constructor(private readonly options: UsageTokenManagerOptions) {}

    /**
     * Returns a snapshot of the caller's current balance without modifying it.
     */
    public inspect(key: string): TokenSnapshot {
        const bucket = this.ensureBucket(key);
        return this.buildSnapshot(bucket);
    }

    /**
     * Attempts to spend the requested amount of tokens. When insufficient
     * balance is available, the caller receives the remaining balance and a
     * countdown describing when to try again.
     */
    public consume(key: string, cost: number): TokenSpendResult {
        if (cost <= 0 || !Number.isFinite(cost)) {
            logger.warn(
                `Ignoring invalid token cost (${cost}) for key ${this.namespacedKey(key)}.`
            );
            const bucket = this.ensureBucket(key);
            return {
                ...this.buildSnapshot(bucket),
                allowed: true,
                cost: 0,
                remainingTokens: bucket.tokens,
            };
        }

        const bucket = this.ensureBucket(key);

        if (bucket.tokens < cost) {
            const neededTokens = cost - bucket.tokens;
            return {
                ...this.buildSnapshot(bucket),
                allowed: false,
                cost,
                remainingTokens: bucket.tokens,
                neededTokens,
            };
        }

        bucket.tokens -= cost;
        return {
            ...this.buildSnapshot(bucket),
            allowed: true,
            cost,
            remainingTokens: bucket.tokens,
        };
    }

    /**
     * Refunds tokens after an unsuccessful attempt. Balances never exceed the
     * configured per-interval maximum so accidental double refunds are bounded.
     */
    public refund(key: string, amount: number): TokenSnapshot {
        if (amount <= 0 || !Number.isFinite(amount)) {
            return this.inspect(key);
        }

        const bucket = this.ensureBucket(key);
        bucket.tokens = Math.min(
            bucket.tokens + amount,
            this.options.tokensPerInterval
        );
        return this.buildSnapshot(bucket);
    }

    private namespacedKey(key: string): string {
        return this.options.namespace
            ? `${this.options.namespace}:${key}`
            : key;
    }

    private ensureBucket(key: string): TokenBucketState {
        const now = Date.now();
        const namespacedKey = this.namespacedKey(key);

        let bucket = this.buckets.get(namespacedKey);
        if (!bucket) {
            bucket = {
                tokens: this.options.tokensPerInterval,
                nextRefreshAt: now + this.options.intervalMs,
            };
            this.buckets.set(namespacedKey, bucket);
            return bucket;
        }

        if (now >= bucket.nextRefreshAt) {
            // Advance the refresh window so long offline periods do not stall.
            const intervalsElapsed =
                Math.floor(
                    (now - bucket.nextRefreshAt) / this.options.intervalMs
                ) + 1;
            bucket.tokens = this.options.tokensPerInterval;
            bucket.nextRefreshAt =
                bucket.nextRefreshAt +
                intervalsElapsed * this.options.intervalMs;
        }

        return bucket;
    }

    private buildSnapshot(bucket: TokenBucketState): TokenSnapshot {
        const now = Date.now();
        return {
            tokens: bucket.tokens,
            nextRefreshAt: bucket.nextRefreshAt,
            refreshInSeconds: Math.max(
                0,
                Math.ceil((bucket.nextRefreshAt - now) / 1000)
            ),
        };
    }
}

const QUALITY_TOKEN_COST: Record<ImageQualityType, number> = {
    auto: 1,
    low: 1,
    medium: 3,
    high: 5,
};

const imageTokenManager = new UsageTokenManager({
    // The shared image configuration controls refresh cadence and available
    // balance so the slash command, planner, and manual flows all read the same
    // limits.
    tokensPerInterval: imageConfig.tokens.tokensPerRefresh,
    intervalMs: imageConfig.tokens.refreshIntervalMs,
    namespace: 'image',
});

export function getImageTokenCost(
    quality: ImageQualityType,
    imageModel: ImageRenderModel
): number {
    // Base costs reflect the relative compute footprint for each quality tier,
    // while model multipliers come from the shared configuration to keep
    // accounting aligned with operator overrides.
    const baseCost = QUALITY_TOKEN_COST[quality] ?? QUALITY_TOKEN_COST.low;
    const multiplier = getImageModelTokenMultiplier(imageModel);
    return baseCost * multiplier;
}

export function consumeImageTokens(
    userId: string,
    quality: ImageQualityType,
    imageModel: ImageRenderModel
): TokenSpendResult {
    const cost = getImageTokenCost(quality, imageModel);
    return imageTokenManager.consume(userId, cost);
}

export function refundImageTokens(
    userId: string,
    qualityOrAmount: ImageQualityType | number,
    imageModel: ImageRenderModel = imageConfig.defaults.imageModel
): TokenSnapshot {
    const amount =
        typeof qualityOrAmount === 'number'
            ? qualityOrAmount
            : getImageTokenCost(qualityOrAmount, imageModel);
    return imageTokenManager.refund(userId, amount);
}

export function inspectImageTokens(userId: string): TokenSnapshot {
    return imageTokenManager.inspect(userId);
}

export function describeTokenAvailability(
    quality: ImageQualityType,
    result: TokenSpendResult,
    imageModel: ImageRenderModel
): string {
    const qualityName = quality.charAt(0).toUpperCase() + quality.slice(1);
    const countdown = formatCountdown(result.refreshInSeconds);
    const neededText =
        result.neededTokens && result.neededTokens > 0
            ? `You need ${result.neededTokens} more token${result.neededTokens === 1 ? '' : 's'} to proceed.`
            : '';

    const waitInstruction =
        result.remainingTokens === 0
            ? `Please wait ${countdown} for your balance to refresh.`
            : `Please wait ${countdown} or pick a lower quality.`;

    return `⚠️ ${qualityName} quality with ${imageModel} requires ${result.cost} token${result.cost === 1 ? '' : 's'}, but you have ${result.remainingTokens}. ${waitInstruction} ${neededText}`.trim();
}

export function buildQualityTokenDescription(
    quality: ImageQualityType,
    imageModel: ImageRenderModel
): string {
    const cost = getImageTokenCost(quality, imageModel);
    return `Uses ${cost} token${cost === 1 ? '' : 's'}`;
}

export function buildModelTokenDescription(
    imageModel: ImageRenderModel,
    quality: ImageQualityType
): string {
    const qualityName = quality.charAt(0).toUpperCase() + quality.slice(1);
    const cost = getImageTokenCost(quality, imageModel);
    return `${qualityName} quality uses ${cost} token${cost === 1 ? '' : 's'}`;
}

export function buildTokenSummaryLine(userId: string): string {
    const snapshot = inspectImageTokens(userId);
    const countdown = formatCountdown(snapshot.refreshInSeconds);
    const parts = [
        `Tokens remaining: ${snapshot.tokens}`,
        `Refreshes in: ${countdown}`,
    ];
    return parts.join(' • ');
}

function formatCountdown(seconds: number): string {
    if (seconds <= 0) {
        return 'now';
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const minutesRemainder = minutes % 60;
        if (minutesRemainder === 0 && remainingSeconds === 0) {
            return `${hours}h`;
        }
        if (remainingSeconds === 0) {
            return `${hours}h${minutesRemainder}m`;
        }
        return `${hours}h${minutesRemainder}m${remainingSeconds}s`;
    }

    if (minutes > 0 && remainingSeconds > 0) {
        return `${minutes}m${remainingSeconds}s`;
    }

    if (minutes > 0) {
        return `${minutes}m`;
    }

    return `${remainingSeconds}s`;
}

