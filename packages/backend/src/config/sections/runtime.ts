/**
 * @description: Builds backend runtime and server config that is resolved once during startup.
 * @footnote-scope: utility
 * @footnote-module: BackendRuntimeSection
 * @footnote-risk: medium - Wrong runtime or bind settings can change startup behavior or request attribution.
 * @footnote-ethics: medium - Proxy and environment flags affect how requests are interpreted and audited.
 */

import { envDefaultValues } from '@footnote/config-spec';
import { supportedNodeEnvs } from '@footnote/contracts/providers';
import {
    parseBooleanEnv,
    parseOptionalTrimmedString,
    parsePositiveIntEnv,
} from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

const SUPPORTED_NODE_ENVS = new Set(supportedNodeEnvs);

export const buildRuntimeSections = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): Pick<RuntimeConfig, 'runtime' | 'server'> => {
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
        runtime: {
            nodeEnv,
            isProduction: nodeEnv === 'production',
            isDevelopment: nodeEnv === 'development',
            flyAppName: parseOptionalTrimmedString(env.FLY_APP_NAME),
        },
        server: {
            dataDir:
                parseOptionalTrimmedString(env.DATA_DIR) ||
                envDefaultValues.DATA_DIR,
            host: parseOptionalTrimmedString(env.HOST) || envDefaultValues.HOST,
            port: parsePositiveIntEnv(
                env.PORT,
                envDefaultValues.PORT,
                'PORT',
                warn
            ),
            trustProxy: parseBooleanEnv(
                env.WEB_TRUST_PROXY,
                envDefaultValues.WEB_TRUST_PROXY,
                'WEB_TRUST_PROXY',
                warn
            ),
        },
    };
};
