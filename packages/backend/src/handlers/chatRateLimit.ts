/**
 * @description: Rate-limit helpers for public and trusted-service reflect traffic.
 * @footnote-scope: utility
 * @footnote-module: ReflectRateLimit
 * @footnote-risk: medium - Incorrect limiter routing can block legitimate traffic or weaken abuse controls.
 * @footnote-ethics: medium - Separate buckets support fair access across public and internal callers.
 */
import { SimpleRateLimiter } from '../services/rateLimiter.js';
import { runtimeConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import type { RateLimitConfig } from '../config/types.js';
import type { ServiceAuth } from './reflectAuth.js';
import type { RequestIdentity } from './reflectRequest.js';
import type { ReflectFailureResponse } from './reflectResponses.js';

// Holds lazily-created fallback limiters so state survives across requests.
type LimiterRef = {
    current: SimpleRateLimiter | null;
};

/**
 * Injected public limiters from the server. Service traffic uses its own
 * env-driven fallback limiter because there is no server-owned instance yet.
 */
type CreateReflectRateLimitControllerOptions = {
    ipRateLimiter: SimpleRateLimiter | null;
    sessionRateLimiter: SimpleRateLimiter | null;
    serviceRateLimiter: SimpleRateLimiter | null;
};

/**
 * Builds a rate-limit controller that preserves the current three-bucket model:
 * public IP, public session, and trusted service traffic.
 */
export const createReflectRateLimitController = ({
    ipRateLimiter,
    sessionRateLimiter,
    serviceRateLimiter,
}: CreateReflectRateLimitControllerOptions) => {
    // These are created lazily so we only allocate fallback state if the caller did not inject a limiter.
    const fallbackIpLimiter: LimiterRef = { current: null };
    const fallbackSessionLimiter: LimiterRef = { current: null };
    const fallbackServiceLimiter: LimiterRef = { current: null };

    const getLimiter = (
        limiter: SimpleRateLimiter | null,
        label: string,
        fallbackConfig: RateLimitConfig,
        fallbackRef: LimiterRef
    ): SimpleRateLimiter => {
        if (limiter) {
            return limiter;
        }

        if (fallbackRef.current) {
            return fallbackRef.current;
        }

        logger.warn(
            `Rate limiter "${label}" missing; creating a fallback limiter.`
        );
        fallbackRef.current = new SimpleRateLimiter({
            limit: fallbackConfig.limit,
            window: fallbackConfig.windowMs,
        });
        return fallbackRef.current;
    };

    const activeIpRateLimiter = getLimiter(
        ipRateLimiter,
        'ip',
        runtimeConfig.rateLimits.web.ip,
        fallbackIpLimiter
    );
    const activeSessionRateLimiter = getLimiter(
        sessionRateLimiter,
        'session',
        runtimeConfig.rateLimits.web.session,
        fallbackSessionLimiter
    );
    const activeServiceRateLimiter = getLimiter(
        serviceRateLimiter,
        'service',
        runtimeConfig.rateLimits.reflectService,
        fallbackServiceLimiter
    );

    const buildRateLimitFailure = (
        error: string,
        retryAfter: number,
        logLabel: string
    ): ReflectFailureResponse => ({
        // Retry-After is mirrored in both the header and JSON payload so browser and service
        // callers can both understand when to try again.
        statusCode: 429,
        payload: {
            error,
            retryAfter,
        },
        logLabel,
        extraHeaders: {
            'Retry-After': retryAfter.toString(),
        },
    });

    const checkRateLimit = (
        serviceAuth: ServiceAuth,
        identity: RequestIdentity
    ):
        | { success: true }
        | { success: false; error: ReflectFailureResponse } => {
        if (serviceAuth.isTrustedService) {
            // Keep service callers off the public IP/session buckets so bot traffic
            // cannot consume the browser allowance.
            const serviceRateLimitResult = activeServiceRateLimiter.check(
                serviceAuth.rateLimitKey ?? 'trusted-service'
            );
            if (!serviceRateLimitResult.allowed) {
                return {
                    success: false,
                    error: buildRateLimitFailure(
                        'Too many requests from this service',
                        serviceRateLimitResult.retryAfter,
                        `reflect service-rate-limited source=${serviceAuth.authSource} retryAfter=${serviceRateLimitResult.retryAfter}`
                    ),
                };
            }

            return { success: true };
        }

        // Public traffic keeps the existing two-layer limiter: broad IP cap first,
        // then a narrower session cap for shared networks.
        const ipRateLimitResult = activeIpRateLimiter.check(identity.clientIp);
        if (!ipRateLimitResult.allowed) {
            return {
                success: false,
                error: buildRateLimitFailure(
                    'Too many requests from this IP',
                    ipRateLimitResult.retryAfter,
                    `reflect ip-rate-limited retryAfter=${ipRateLimitResult.retryAfter}`
                ),
            };
        }

        const sessionRateLimitResult = activeSessionRateLimiter.check(
            identity.sessionId
        );
        if (!sessionRateLimitResult.allowed) {
            return {
                success: false,
                error: buildRateLimitFailure(
                    'Too many requests for this session',
                    sessionRateLimitResult.retryAfter,
                    `reflect session-rate-limited retryAfter=${sessionRateLimitResult.retryAfter}`
                ),
            };
        }

        return { success: true };
    };

    return {
        checkRateLimit,
    };
};
