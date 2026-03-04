/**
 * @description: Builds backend runtime-mode config such as NODE_ENV and Fly runtime flags.
 * @footnote-scope: utility
 * @footnote-module: BackendRuntimeSection
 * @footnote-risk: low - Wrong runtime flags mainly affect environment-specific branching.
 * @footnote-ethics: low - These flags guide behavior but do not directly expose sensitive data.
 */

import { envDefaultValues } from '@footnote/config-spec';
import { parseOptionalTrimmedString } from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

export const buildRuntimeSection = (
    env: NodeJS.ProcessEnv,
    _warn: WarningSink
): RuntimeConfig['runtime'] => {
    const nodeEnv =
        parseOptionalTrimmedString(env.NODE_ENV) || envDefaultValues.NODE_ENV;

    return {
        nodeEnv,
        isProduction: nodeEnv === 'production',
        isDevelopment: nodeEnv !== 'production',
        flyAppName: parseOptionalTrimmedString(env.FLY_APP_NAME),
    };
};
