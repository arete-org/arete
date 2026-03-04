/**
 * @description: Builds backend server binding and proxy config.
 * @footnote-scope: utility
 * @footnote-module: BackendServerSection
 * @footnote-risk: medium - Wrong host, port, or trust-proxy values can break routing or abuse controls.
 * @footnote-ethics: medium - Proxy handling affects request attribution and rate limiting.
 */

import { envDefaultValues } from '@footnote/config-spec';
import {
    parseBooleanEnv,
    parseOptionalTrimmedString,
    parsePositiveIntEnv,
} from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

export const buildServerSection = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): RuntimeConfig['server'] => ({
    dataDir:
        parseOptionalTrimmedString(env.DATA_DIR) || envDefaultValues.DATA_DIR,
    host: parseOptionalTrimmedString(env.HOST) || envDefaultValues.HOST,
    port: parsePositiveIntEnv(env.PORT, envDefaultValues.PORT, 'PORT', warn),
    trustProxy: parseBooleanEnv(
        env.WEB_TRUST_PROXY,
        envDefaultValues.WEB_TRUST_PROXY
    ),
});
