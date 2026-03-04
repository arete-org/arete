/**
 * @description: Builds trace ingestion auth and body-limit config.
 * @footnote-scope: utility
 * @footnote-module: BackendTraceSection
 * @footnote-risk: medium - Wrong trace limits or auth settings can block observability data.
 * @footnote-ethics: medium - Trace ingestion affects auditability and provenance availability.
 */

import { envDefaultValues } from '@footnote/config-spec';
import {
    parseOptionalTrimmedString,
    parsePositiveIntEnv,
} from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

export const buildTraceSection = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): RuntimeConfig['trace'] => ({
    apiToken: parseOptionalTrimmedString(env.TRACE_API_TOKEN),
    maxBodyBytes: parsePositiveIntEnv(
        env.TRACE_API_MAX_BODY_BYTES,
        envDefaultValues.TRACE_API_MAX_BODY_BYTES,
        'TRACE_API_MAX_BODY_BYTES',
        warn
    ),
});
