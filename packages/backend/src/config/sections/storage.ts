/**
 * @description: Builds backend storage-path and incident-secret config.
 * @footnote-scope: utility
 * @footnote-module: BackendStorageSection
 * @footnote-risk: medium - Wrong storage paths or missing incident secrets can break persistence and pseudonymization.
 * @footnote-ethics: high - Incident storage and pseudonymization directly affect privacy guarantees.
 */

import { parseOptionalTrimmedString } from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

export const buildStorageSection = (
    env: NodeJS.ProcessEnv,
    _warn: WarningSink
): RuntimeConfig['storage'] => ({
    provenanceSqlitePath: parseOptionalTrimmedString(env.PROVENANCE_SQLITE_PATH),
    incidentPseudonymizationSecret: parseOptionalTrimmedString(
        env.INCIDENT_PSEUDONYMIZATION_SECRET
    ),
    incidentSqlitePath: parseOptionalTrimmedString(env.INCIDENT_SQLITE_PATH),
});
