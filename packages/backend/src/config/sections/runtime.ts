/**
 * @description: Builds backend runtime-mode config such as NODE_ENV and Fly runtime flags.
 * @footnote-scope: utility
 * @footnote-module: BackendRuntimeSection
 * @footnote-risk: low - Wrong runtime flags mainly affect environment-specific branching.
 * @footnote-ethics: low - These flags guide behavior but do not directly expose sensitive data.
 */

import { envDefaultValues } from '@footnote/config-spec';
import { supportedNodeEnvs } from '@footnote/contracts/providers';
import { parseOptionalTrimmedString } from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

const SUPPORTED_NODE_ENVS = new Set(supportedNodeEnvs);

export const buildRuntimeSection = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): RuntimeConfig['runtime'] => {
    const configuredNodeEnv = parseOptionalTrimmedString(env.NODE_ENV);
    const nodeEnv = configuredNodeEnv
        ? SUPPORTED_NODE_ENVS.has(
              configuredNodeEnv as (typeof supportedNodeEnvs)[number]
          )
            ? (configuredNodeEnv as RuntimeConfig['runtime']['nodeEnv'])
            : (() => {
                  warn(
                      `Ignoring unsupported NODE_ENV "${configuredNodeEnv}". Expected one of ${supportedNodeEnvs.join(', ')}. Using default (${envDefaultValues.NODE_ENV}).`
                  );
                  return envDefaultValues.NODE_ENV;
              })()
        : envDefaultValues.NODE_ENV;

    return {
        nodeEnv,
        isProduction: nodeEnv === 'production',
        isDevelopment: nodeEnv === 'development',
        flyAppName: parseOptionalTrimmedString(env.FLY_APP_NAME),
    };
};
