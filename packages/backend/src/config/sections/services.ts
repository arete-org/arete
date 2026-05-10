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
type WebSearchProviderMode = 'searxng' | 'brave' | 'serpapi';
const WEB_SEARCH_PROVIDER_MODES: ReadonlySet<WebSearchProviderMode> = new Set([
    'searxng',
    'brave',
    'serpapi',
]);

const parseWebSearchProviderPriority = (
    raw: string | undefined,
    warn: WarningSink
): WebSearchProviderMode[] => {
    const fallback: WebSearchProviderMode[] = ['searxng', 'brave', 'serpapi'];
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return fallback;
    }

    const normalized = raw
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);
    if (normalized.length === 0) {
        return fallback;
    }

    const priority: WebSearchProviderMode[] = [];
    for (const candidate of normalized) {
        if (
            !WEB_SEARCH_PROVIDER_MODES.has(candidate as WebSearchProviderMode)
        ) {
            warn(
                `Ignoring unsupported web-search provider "${candidate}" in CHAT_CONTEXT_WEB_SEARCH_PROVIDER_PRIORITY.`
            );
            continue;
        }
        const provider = candidate as WebSearchProviderMode;
        if (!priority.includes(provider)) {
            priority.push(provider);
        }
    }

    if (priority.length === 0) {
        return fallback;
    }
    return priority;
};

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
            webSearch: {
                enabled: parseBooleanEnv(
                    env.CHAT_CONTEXT_WEB_SEARCH_ENABLED,
                    true,
                    'CHAT_CONTEXT_WEB_SEARCH_ENABLED',
                    warn
                ),
                providerPriority: parseWebSearchProviderPriority(
                    env.CHAT_CONTEXT_WEB_SEARCH_PROVIDER_PRIORITY,
                    warn
                ),
                searxngBaseUrl: parseOptionalTrimmedString(
                    env.CHAT_CONTEXT_WEB_SEARCH_SEARXNG_BASE_URL
                ),
                braveApiKey: parseOptionalTrimmedString(
                    env.CHAT_CONTEXT_WEB_SEARCH_BRAVE_API_KEY
                ),
                serpApiKey: parseOptionalTrimmedString(
                    env.CHAT_CONTEXT_WEB_SEARCH_SERPAPI_API_KEY
                ),
                serpApiEngine: parseOptionalTrimmedString(
                    env.CHAT_CONTEXT_WEB_SEARCH_SERPAPI_ENGINE
                ),
                serpApiGl: parseOptionalTrimmedString(
                    env.CHAT_CONTEXT_WEB_SEARCH_SERPAPI_GL
                ),
                serpApiHl: parseOptionalTrimmedString(
                    env.CHAT_CONTEXT_WEB_SEARCH_SERPAPI_HL
                ),
                providerTimeoutMs: parsePositiveIntEnv(
                    env.CHAT_CONTEXT_WEB_SEARCH_PROVIDER_TIMEOUT_MS,
                    12000,
                    'CHAT_CONTEXT_WEB_SEARCH_PROVIDER_TIMEOUT_MS',
                    warn
                ),
                maxResults: Math.max(
                    1,
                    parsePositiveIntEnv(
                        env.CHAT_CONTEXT_WEB_SEARCH_MAX_RESULTS,
                        6,
                        'CHAT_CONTEXT_WEB_SEARCH_MAX_RESULTS',
                        warn
                    )
                ),
                openAiNativeSearchFromHintsEnabled: parseBooleanEnv(
                    env.CHAT_CONTEXT_WEB_SEARCH_OPENAI_NATIVE_FROM_HINTS_ENABLED,
                    true,
                    'CHAT_CONTEXT_WEB_SEARCH_OPENAI_NATIVE_FROM_HINTS_ENABLED',
                    warn
                ),
            },
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
