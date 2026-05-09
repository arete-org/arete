/**
 * @description: Builds trusted backend service auth and request-body limit settings.
 * @footnote-scope: utility
 * @footnote-module: BackendServiceSections
 * @footnote-risk: medium - Wrong tokens or size limits can break internal service traffic or trace writes.
 * @footnote-ethics: medium - These settings affect trusted request handling and observability reliability.
 */

import { envDefaultValues } from '@footnote/config-spec';
import type { WorkflowModeId } from '@footnote/contracts/policy';
import {
    parseBooleanEnv,
    parseNonNegativeIntEnv,
    parseOptionalTrimmedString,
    parsePositiveIntEnv,
    parseStringUnionEnv,
} from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

const CHAT_WORKFLOW_MODE_IDS: ReadonlySet<WorkflowModeId> = new Set([
    'balanced',
    'grounded',
]);
const REVERSE_IMAGE_SEARCH_PROVIDER_MODES = new Set([
    'none',
    'serpapi',
] as const);
type ReverseImageSearchProviderMode = 'none' | 'serpapi';

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
        modeId: parseStringUnionEnv<WorkflowModeId>(
            env.CHAT_WORKFLOW_MODE_ID,
            'grounded',
            'CHAT_WORKFLOW_MODE_ID',
            CHAT_WORKFLOW_MODE_IDS,
            warn
        ),
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
        contextIntegrations: {
            reverseImageSearch: {
                enabled: parseBooleanEnv(
                    env.CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_ENABLED,
                    true,
                    'CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_ENABLED',
                    warn
                ),
                autoRunWithImageAttachments: parseBooleanEnv(
                    env.CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_AUTORUN,
                    true,
                    'CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_AUTORUN',
                    warn
                ),
                minConfidence: Math.max(
                    0,
                    Math.min(
                        1,
                        parseNonNegativeIntEnv(
                            env.CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_MIN_CONFIDENCE_PERCENT,
                            35,
                            'CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_MIN_CONFIDENCE_PERCENT',
                            warn
                        ) / 100
                    )
                ),
                maxMatchesPerImage: Math.max(
                    1,
                    parsePositiveIntEnv(
                        env.CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_MAX_MATCHES_PER_IMAGE,
                        2,
                        'CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_MAX_MATCHES_PER_IMAGE',
                        warn
                    )
                ),
                provider: parseStringUnionEnv<ReverseImageSearchProviderMode>(
                    env.CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_PROVIDER,
                    'none',
                    'CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_PROVIDER',
                    REVERSE_IMAGE_SEARCH_PROVIDER_MODES,
                    warn
                ),
                serpApiKey: parseOptionalTrimmedString(
                    env.CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_SERPAPI_API_KEY
                ),
                providerTimeoutMs: parsePositiveIntEnv(
                    env.CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_PROVIDER_TIMEOUT_MS,
                    12000,
                    'CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_PROVIDER_TIMEOUT_MS',
                    warn
                ),
            },
        },
    },
});
