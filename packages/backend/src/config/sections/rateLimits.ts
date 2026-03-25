/**
 * @description: Builds backend public and trusted-service rate-limit defaults.
 * @footnote-scope: utility
 * @footnote-module: BackendRateLimitSection
 * @footnote-risk: high - Wrong rate-limit values can either permit abuse or block normal traffic.
 * @footnote-ethics: medium - Abuse controls directly affect fairness and service reliability.
 */

import { envDefaultValues } from '@footnote/config-spec';
import { parsePositiveIntEnv } from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

/**
 * Groups public and trusted-service rate limits so abuse controls stay easy to
 * inspect in one place.
 */
export const buildRateLimitsSection = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): RuntimeConfig['rateLimits'] => ({
    web: {
        ip: {
            limit: parsePositiveIntEnv(
                env.WEB_API_RATE_LIMIT_IP,
                envDefaultValues.WEB_API_RATE_LIMIT_IP,
                'WEB_API_RATE_LIMIT_IP',
                warn
            ),
            windowMs: parsePositiveIntEnv(
                env.WEB_API_RATE_LIMIT_IP_WINDOW_MS,
                envDefaultValues.WEB_API_RATE_LIMIT_IP_WINDOW_MS,
                'WEB_API_RATE_LIMIT_IP_WINDOW_MS',
                warn
            ),
        },
        session: {
            limit: parsePositiveIntEnv(
                env.WEB_API_RATE_LIMIT_SESSION,
                envDefaultValues.WEB_API_RATE_LIMIT_SESSION,
                'WEB_API_RATE_LIMIT_SESSION',
                warn
            ),
            windowMs: parsePositiveIntEnv(
                env.WEB_API_RATE_LIMIT_SESSION_WINDOW_MS,
                envDefaultValues.WEB_API_RATE_LIMIT_SESSION_WINDOW_MS,
                'WEB_API_RATE_LIMIT_SESSION_WINDOW_MS',
                warn
            ),
        },
    },
    chatService: {
        limit: parsePositiveIntEnv(
            env.REFLECT_SERVICE_RATE_LIMIT,
            envDefaultValues.REFLECT_SERVICE_RATE_LIMIT,
            'REFLECT_SERVICE_RATE_LIMIT',
            warn
        ),
        windowMs: parsePositiveIntEnv(
            env.REFLECT_SERVICE_RATE_LIMIT_WINDOW_MS,
            envDefaultValues.REFLECT_SERVICE_RATE_LIMIT_WINDOW_MS,
            'REFLECT_SERVICE_RATE_LIMIT_WINDOW_MS',
            warn
        ),
    },
    traceApi: {
        limit: parsePositiveIntEnv(
            env.TRACE_API_RATE_LIMIT,
            envDefaultValues.TRACE_API_RATE_LIMIT,
            'TRACE_API_RATE_LIMIT',
            warn
        ),
        windowMs: parsePositiveIntEnv(
            env.TRACE_API_RATE_LIMIT_WINDOW_MS,
            envDefaultValues.TRACE_API_RATE_LIMIT_WINDOW_MS,
            'TRACE_API_RATE_LIMIT_WINDOW_MS',
            warn
        ),
    },
});
