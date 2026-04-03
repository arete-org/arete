/**
 * @description: Builds trusted backend service auth and request-body limit settings.
 * @footnote-scope: utility
 * @footnote-module: BackendServiceSections
 * @footnote-risk: medium - Wrong tokens or size limits can break internal service traffic or trace writes.
 * @footnote-ethics: medium - These settings affect trusted request handling and observability reliability.
 */

import { envDefaultValues } from '@footnote/config-spec';
import {
    parseBooleanEnv,
    parseNonNegativeIntEnv,
    parseOptionalTrimmedString,
    parsePositiveIntEnv,
} from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

/**
 * Resolves auth tokens and body-size limits for trusted backend-only service
 * endpoints.
 */
export const buildServiceSections = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): Pick<RuntimeConfig, 'reflect' | 'trace' | 'chatWorkflow'> => ({
    reflect: {
        serviceToken: parseOptionalTrimmedString(env.REFLECT_SERVICE_TOKEN),
        maxBodyBytes: parsePositiveIntEnv(
            env.REFLECT_API_MAX_BODY_BYTES,
            envDefaultValues.REFLECT_API_MAX_BODY_BYTES,
            'REFLECT_API_MAX_BODY_BYTES',
            warn
        ),
    },
    trace: {
        apiToken: parseOptionalTrimmedString(env.TRACE_API_TOKEN),
        maxBodyBytes: parsePositiveIntEnv(
            env.TRACE_API_MAX_BODY_BYTES,
            envDefaultValues.TRACE_API_MAX_BODY_BYTES,
            'TRACE_API_MAX_BODY_BYTES',
            warn
        ),
    },
    chatWorkflow: {
        reviewLoopEnabled: parseBooleanEnv(
            env.CHAT_REVIEW_LOOP_ENABLED,
            false,
            'CHAT_REVIEW_LOOP_ENABLED',
            warn
        ),
        maxIterations: parseNonNegativeIntEnv(
            env.CHAT_REVIEW_LOOP_MAX_ITERATIONS,
            2,
            'CHAT_REVIEW_LOOP_MAX_ITERATIONS',
            warn
        ),
        maxDurationMs: parsePositiveIntEnv(
            env.CHAT_REVIEW_LOOP_MAX_DURATION_MS,
            15000,
            'CHAT_REVIEW_LOOP_MAX_DURATION_MS',
            warn
        ),
    },
});
