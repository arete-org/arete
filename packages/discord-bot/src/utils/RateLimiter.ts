/**
 * @description: Handles rate limiting for Discord and web API interactions.
 * @footnote-scope: utility
 * @footnote-module: RateLimiter
 * @footnote-risk: moderate - Incorrect limits can cause abuse or block valid users.
 * @footnote-ethics: moderate - Rate limits affect user access and fairness.
 */

type RateLimitScope = 'user' | 'channel' | 'guild' | 'session';

interface RateLimitOptions {
    limit: number; // Max requests per time window
    window: number; // Time window in milliseconds
    scope: RateLimitScope; // Scope of the rate limit (user, channel, guild, or session)
    errorMessage?: string; // Optional custom error message when rate limited
}

interface RateLimitRecord {
    count: number;
    resetTime: number;
}

/**
 * Handles rate limiting for Discord interactions and web API contexts.
 * Supports different scopes (user, channel, guild, session) with configurable limits and time windows.
 * @class RateLimiter
 */
export class RateLimiter {
    private readonly limits: Map<string, RateLimitRecord> = new Map();
    private readonly options: Required<RateLimitOptions>;

    /**
     * Creates a new RateLimiter instance.
     * @param {RateLimitOptions} options - Configuration options for the rate limiter
     */
    constructor(options: RateLimitOptions) {
        this.options = {
            errorMessage: 'Rate limit exceeded. Please try again later.',
            ...options,
        };
    }

    /**
     * Gets a unique key for the rate limit based on scope and ID.
     * @private
     */
    private getKey(scopeId: string, scope: RateLimitScope): string {
        return `${scope}:${scopeId}`;
    }

    /**
     * Checks if a request is allowed based on the rate limit rules.
     * @param {string} userId - The ID of the user making the request
     * @param {string} channelId - The ID of the channel where the request was made
     * @param {string} guildId - The ID of the guild where the request was made
     * @returns {{allowed: boolean, retryAfter?: number, error?: string}} Result of the rate limit check
     */
    public check(
        userId: string,
        channelId: string,
        guildId?: string
    ): { allowed: boolean; retryAfter?: number; error?: string } {
        const now = Date.now();
        const scopeId = this.getScopeId(userId, channelId, guildId);
        const key = this.getKey(scopeId, this.options.scope);
        const record = this.limits.get(key);

        // If the record exists and has not expired
        if (record && record.resetTime > now) {
            // If the limit has been reached
            if (record.count >= this.options.limit) {
                return {
                    allowed: false,
                    retryAfter: Math.ceil((record.resetTime - now) / 1000),
                    error: this.options.errorMessage,
                };
            }
            record.count++; // Update existing record
        } else {
            // Create new record
            this.limits.set(key, {
                count: 1,
                resetTime: now + this.options.window,
            });
        }

        return { allowed: true };
    }

    /**
     * Gets the appropriate scope ID based on the rate limiter's scope.
     * @private
     */
    private getScopeId(
        userId: string,
        channelId: string,
        guildId?: string
    ): string {
        switch (this.options.scope) {
            case 'user':
                return userId;
            case 'channel':
                return channelId;
            case 'guild':
                if (!guildId) {
                    throw new Error(
                        'Guild ID is required for guild-level rate limiting'
                    );
                }
                return guildId;
            case 'session':
                return userId; // For session scope, userId parameter contains the sessionId
            default:
                throw new Error(`Unsupported scope: ${this.options.scope}`);
        }
    }

    /**
     * Clears expired rate limit records.
     * Should be called periodically to prevent memory leaks.
     */
    // TODO: Implement cleanup
    public cleanup(): void {
        const now = Date.now();
        for (const [key, record] of this.limits.entries()) {
            if (record.resetTime <= now) {
                this.limits.delete(key);
            }
        }
    }
}

/**
 * Creates a pre-configured rate limiter for user-level rate limiting.
 * @param limit - Maximum requests allowed
 * @param window - Time window in milliseconds
 * @returns A RateLimiter instance configured for user-level limiting
 */
export function createUserRateLimiter(
    limit: number,
    window: number
): RateLimiter {
    return new RateLimiter({
        limit,
        window,
        scope: 'user',
        errorMessage: 'You are sending messages too quickly. Please slow down.',
    });
}

/**
 * Creates a pre-configured rate limiter for channel-level rate limiting.
 * @param limit - Maximum requests allowed
 * @param window - Time window in milliseconds
 * @returns A RateLimiter instance configured for channel-level limiting
 */
export function createChannelRateLimiter(
    limit: number,
    window: number
): RateLimiter {
    return new RateLimiter({
        limit,
        window,
        scope: 'channel',
        errorMessage:
            'Hit the rate limit for this channel. Please try again later.',
    });
}

/**
 * Creates a pre-configured rate limiter for guild-level rate limiting.
 * @param limit - Maximum requests allowed
 * @param window - Time window in milliseconds
 * @returns A RateLimiter instance configured for guild-level limiting
 */
export function createGuildRateLimiter(
    limit: number,
    window: number
): RateLimiter {
    return new RateLimiter({
        limit,
        window,
        scope: 'guild',
        errorMessage:
            'Hit the rate limit for this server/guild. Please try again later.',
    });
}

