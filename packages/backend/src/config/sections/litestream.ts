/**
 * @description: Parses optional Litestream replication metadata used for startup diagnostics.
 * @footnote-scope: utility
 * @footnote-module: BackendLitestreamSection
 * @footnote-risk: low - Incorrect parsing only affects diagnostic visibility during boot logs.
 * @footnote-ethics: low - These values are operational metadata and do not drive user-facing decisions.
 */

import { parseOptionalTrimmedString } from '../parsers.js';
import type { RuntimeConfig } from '../types.js';

/**
 * Keep Litestream env parsing centralized with other runtime config sections.
 */
export const buildLitestreamSection = (
    env: NodeJS.ProcessEnv
): RuntimeConfig['litestream'] => ({
    replicaUrl: parseOptionalTrimmedString(env.LITESTREAM_REPLICA_URL),
    latestSnapshotAt: parseOptionalTrimmedString(
        env.LITESTREAM_LATEST_SNAPSHOT_AT
    ),
});
