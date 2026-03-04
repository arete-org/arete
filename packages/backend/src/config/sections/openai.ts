/**
 * @description: Builds backend OpenAI defaults and timeout config.
 * @footnote-scope: utility
 * @footnote-module: BackendOpenAISection
 * @footnote-risk: medium - Wrong model or timeout defaults can change reflect behavior or cost.
 * @footnote-ethics: medium - Model and reasoning defaults affect system behavior and transparency.
 */

import { envDefaultValues } from '@footnote/config-spec';
import type {
    SupportedReasoningEffort,
    SupportedVerbosity,
} from '@footnote/contracts/providers';
import {
    parseOptionalTrimmedString,
    parsePositiveIntEnv,
    parseStringUnionEnv,
} from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

const VALID_REASONING_EFFORTS = new Set<SupportedReasoningEffort>([
    'low',
    'medium',
    'high',
]);
const VALID_VERBOSITY_LEVELS = new Set<SupportedVerbosity>([
    'low',
    'medium',
    'high',
]);

export const buildOpenAISection = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): RuntimeConfig['openai'] => ({
    apiKey: parseOptionalTrimmedString(env.OPENAI_API_KEY),
    defaultModel:
        parseOptionalTrimmedString(env.DEFAULT_MODEL) ||
        envDefaultValues.DEFAULT_MODEL,
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
