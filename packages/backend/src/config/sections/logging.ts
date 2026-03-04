/**
 * @description: Builds backend logging defaults without coupling the logger to full runtime config.
 * @footnote-scope: utility
 * @footnote-module: BackendLoggingSection
 * @footnote-risk: low - Wrong logging defaults mainly affect observability quality.
 * @footnote-ethics: medium - Logging config influences what gets retained and how operators debug incidents.
 */

import { envDefaultValues } from '@footnote/config-spec';
import { parseLogLevelEnv, parseOptionalTrimmedString } from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

export const buildLoggingSection = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): RuntimeConfig['logging'] => ({
    directory: parseOptionalTrimmedString(env.LOG_DIR) || envDefaultValues.LOG_DIR,
    level: parseLogLevelEnv(env.LOG_LEVEL, envDefaultValues.LOG_LEVEL, warn),
});
