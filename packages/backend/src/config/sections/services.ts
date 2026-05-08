/**
 * @description: Builds trusted backend service auth and request-body limit settings.
 * @footnote-scope: utility
 * @footnote-module: BackendServiceSections
 * @footnote-risk: medium - Wrong tokens or size limits can break internal service traffic or trace writes.
 * @footnote-ethics: medium - These settings affect trusted request handling and observability reliability.
 */

import { envDefaultValues } from '@footnote/config-spec';
import type { WorkflowModeId } from '@footnote/contracts/ethics-core';
import {
    parseBooleanEnv,
    parseCsvEnv,
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
const WEB_SEARCH_PROVIDER_MODES: ReadonlySet<
    RuntimeConfig['webSearchProviders']['mode']
> = new Set(['auto', 'strict', 'preferred_order']);
const WEB_SEARCH_PROVIDER_IDS: ReadonlySet<
    RuntimeConfig['webSearchProviders']['enabledProviders'][number]
> = new Set(['openai', 'brave', 'searxng']);

const parseWebSearchProviders = (
    value: string[] | undefined,
    fallback: RuntimeConfig['webSearchProviders']['enabledProviders'],
    key: string,
    warn: WarningSink
): RuntimeConfig['webSearchProviders']['enabledProviders'] => {
    const candidates = value ?? fallback;
    const normalized = candidates
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);
    const validProviders = normalized.filter((entry) =>
        WEB_SEARCH_PROVIDER_IDS.has(
            entry as RuntimeConfig['webSearchProviders']['enabledProviders'][number]
        )
    ) as RuntimeConfig['webSearchProviders']['enabledProviders'];
    const invalidProviders = normalized.filter(
        (entry) =>
            !WEB_SEARCH_PROVIDER_IDS.has(
                entry as RuntimeConfig['webSearchProviders']['enabledProviders'][number]
            )
    );
    if (invalidProviders.length > 0) {
        warn(
            `Ignoring invalid web search providers for ${key}: ${invalidProviders.join(', ')}.`
        );
    }
    if (validProviders.length === 0) {
        return [...fallback];
    }
    return [...new Set(validProviders)];
};

/**
 * Resolves auth tokens and body-size limits for trusted backend-only service
 * endpoints.
 */
export const buildServiceSections = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): Pick<
    RuntimeConfig,
    'reflect' | 'trace' | 'chatWorkflow' | 'webSearchProviders'
> => ({
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
    },
    webSearchProviders: {
        mode: parseStringUnionEnv<RuntimeConfig['webSearchProviders']['mode']>(
            env.WEB_SEARCH_PROVIDER_MODE,
            'auto',
            'WEB_SEARCH_PROVIDER_MODE',
            WEB_SEARCH_PROVIDER_MODES,
            warn
        ),
        enabledProviders: parseWebSearchProviders(
            parseCsvEnv(env.WEB_SEARCH_ENABLED_PROVIDERS, ['openai']),
            ['openai'],
            'WEB_SEARCH_ENABLED_PROVIDERS',
            warn
        ),
        providerOrder: parseWebSearchProviders(
            parseCsvEnv(env.WEB_SEARCH_PROVIDER_ORDER, ['openai']),
            ['openai'],
            'WEB_SEARCH_PROVIDER_ORDER',
            warn
        ),
    },
});
