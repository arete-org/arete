/**
 * @description: Shared helpers for trace store serialization and validation. Split out to
 * avoid circular imports between the trace store factory and SQLite backend.
 * @arete-scope: utility
 * @arete-module: TraceStoreUtils
 * @arete-risk: moderate - Validation mistakes can corrupt or reject audit data.
 * @arete-ethics: high - Maintains integrity of provenance metadata and audit trails.
 */

import type { ResponseMetadata } from '../../ethics-core/index.js';
import { ResponseMetadataSchema } from '@footnote/contracts/web/schemas';

export const traceStoreJsonReplacer = (_key: string, value: unknown) => {
    if (value instanceof URL) {
        return value.toString();
    }

    return value;
};

export function assertValidResponseMetadata(
    value: unknown,
    source: string,
    responseId: string
): asserts value is ResponseMetadata {
    const parsedMetadata = ResponseMetadataSchema.safeParse(value);
    if (parsedMetadata.success) {
        return;
    }

    const firstIssue = parsedMetadata.error.issues[0];
    const issuePath =
        firstIssue && firstIssue.path.length > 0
            ? firstIssue.path.join('.')
            : 'root';
    const issueMessage = firstIssue?.message ?? 'Invalid metadata payload.';
    throw new Error(
        `Trace record "${source}" for response "${responseId}" is invalid (${issuePath}: ${issueMessage}).`
    );
}
