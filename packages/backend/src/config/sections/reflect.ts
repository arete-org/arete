/**
 * @description: Builds trusted reflect service config and request body limits.
 * @footnote-scope: utility
 * @footnote-module: BackendReflectSection
 * @footnote-risk: medium - Wrong limits or service tokens can break trusted reflect traffic.
 * @footnote-ethics: medium - Reflect auth and payload sizing affect reliability and abuse resistance.
 */

import { envDefaultValues } from '@footnote/config-spec';
import {
    parseOptionalTrimmedString,
    parsePositiveIntEnv,
} from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

export const buildReflectSection = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): RuntimeConfig['reflect'] => ({
    serviceToken: parseOptionalTrimmedString(env.REFLECT_SERVICE_TOKEN),
    maxBodyBytes: parsePositiveIntEnv(
        env.REFLECT_API_MAX_BODY_BYTES,
        envDefaultValues.REFLECT_API_MAX_BODY_BYTES,
        'REFLECT_API_MAX_BODY_BYTES',
        warn
    ),
});
