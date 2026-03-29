/**
 * @description: Builds backend OpenAI defaults and timeout config.
 * @footnote-scope: utility
 * @footnote-module: BackendOpenAISection
 * @footnote-risk: medium - Wrong model or timeout defaults can change reflect behavior or cost.
 * @footnote-ethics: medium - Model and reasoning defaults affect system behavior and transparency.
 */

import { envDefaultValues, envSpecByKey } from '@footnote/config-spec';
import type {
    SupportedOpenAIRealtimeModel,
    SupportedOpenAITtsVoice,
    SupportedReasoningEffort,
    SupportedVerbosity,
} from '@footnote/contracts/providers';
import {
    parseBooleanEnv,
    parseOptionalTrimmedString,
    parsePositiveIntEnv,
    parseStringUnionEnv,
} from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

const VALID_REASONING_EFFORTS = new Set<SupportedReasoningEffort>(
    (envSpecByKey.DEFAULT_REASONING_EFFORT.allowedValues ??
        []) as readonly SupportedReasoningEffort[]
);
const VALID_VERBOSITY_LEVELS = new Set<SupportedVerbosity>(
    (envSpecByKey.DEFAULT_VERBOSITY.allowedValues ??
        []) as readonly SupportedVerbosity[]
);
const VALID_REALTIME_MODELS = new Set<SupportedOpenAIRealtimeModel>(
    (envSpecByKey.REALTIME_DEFAULT_MODEL.allowedValues ??
        []) as readonly SupportedOpenAIRealtimeModel[]
);
const VALID_REALTIME_VOICES = new Set<SupportedOpenAITtsVoice>(
    (envSpecByKey.REALTIME_DEFAULT_VOICE.allowedValues ??
        []) as readonly SupportedOpenAITtsVoice[]
);

/**
 * Builds backend OpenAI defaults, including planner-safe fallbacks for model
 * settings and request timeout.
 */
export const buildOpenAISection = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): RuntimeConfig['openai'] => ({
    apiKey: parseOptionalTrimmedString(env.OPENAI_API_KEY),
    defaultModel:
        parseOptionalTrimmedString(env.DEFAULT_MODEL) ||
        envDefaultValues.DEFAULT_MODEL,
    plannerStructuredOutputEnabled: parseBooleanEnv(
        env.PLANNER_STRUCTURED_OUTPUT_ENABLED,
        envDefaultValues.PLANNER_STRUCTURED_OUTPUT_ENABLED,
        'PLANNER_STRUCTURED_OUTPUT_ENABLED',
        warn
    ),
    plannerAllowTextJsonCompatibilityFallback: parseBooleanEnv(
        env.PLANNER_ALLOW_TEXT_JSON_COMPATIBILITY_FALLBACK,
        envDefaultValues.PLANNER_ALLOW_TEXT_JSON_COMPATIBILITY_FALLBACK,
        'PLANNER_ALLOW_TEXT_JSON_COMPATIBILITY_FALLBACK',
        warn
    ),
    defaultRealtimeModel: parseStringUnionEnv(
        env.REALTIME_DEFAULT_MODEL,
        envDefaultValues.REALTIME_DEFAULT_MODEL,
        'REALTIME_DEFAULT_MODEL',
        VALID_REALTIME_MODELS,
        warn
    ),
    defaultRealtimeVoice: parseStringUnionEnv(
        env.REALTIME_DEFAULT_VOICE,
        envDefaultValues.REALTIME_DEFAULT_VOICE,
        'REALTIME_DEFAULT_VOICE',
        VALID_REALTIME_VOICES,
        warn
    ),
    defaultReasoningEffort: parseStringUnionEnv(
        env.DEFAULT_REASONING_EFFORT,
        envDefaultValues.DEFAULT_REASONING_EFFORT,
        'DEFAULT_REASONING_EFFORT',
        VALID_REASONING_EFFORTS,
        warn
    ),
    defaultVerbosity: parseStringUnionEnv(
        env.DEFAULT_VERBOSITY,
        envDefaultValues.DEFAULT_VERBOSITY,
        'DEFAULT_VERBOSITY',
        VALID_VERBOSITY_LEVELS,
        warn
    ),
    defaultChannelContext: {
        channelId: 'default',
    },
    requestTimeoutMs: parsePositiveIntEnv(
        env.OPENAI_REQUEST_TIMEOUT_MS,
        envDefaultValues.OPENAI_REQUEST_TIMEOUT_MS,
        'OPENAI_REQUEST_TIMEOUT_MS',
        warn
    ),
});
