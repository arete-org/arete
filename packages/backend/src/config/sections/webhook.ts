/**
 * @description: Builds GitHub webhook auth and size-limit config.
 * @footnote-scope: utility
 * @footnote-module: BackendWebhookSection
 * @footnote-risk: medium - Wrong webhook config can reject valid blog sync events or accept invalid ones.
 * @footnote-ethics: low - This is operational integration config rather than user-facing policy.
 */

import { envDefaultValues } from '@footnote/config-spec';
import { parseOptionalTrimmedString, parsePositiveIntEnv } from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

/**
 * Resolves GitHub webhook credentials and request-size limits for blog sync
 * traffic.
 */
export const buildWebhookSection = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): RuntimeConfig['webhook'] => ({
    secret: parseOptionalTrimmedString(env.GITHUB_WEBHOOK_SECRET),
    repository:
        parseOptionalTrimmedString(env.GITHUB_WEBHOOK_REPOSITORY) ||
        envDefaultValues.GITHUB_WEBHOOK_REPOSITORY,
    maxBodyBytes: parsePositiveIntEnv(
        env.GITHUB_WEBHOOK_MAX_BODY_BYTES,
        envDefaultValues.GITHUB_WEBHOOK_MAX_BODY_BYTES,
        'GITHUB_WEBHOOK_MAX_BODY_BYTES',
        warn
    ),
});
