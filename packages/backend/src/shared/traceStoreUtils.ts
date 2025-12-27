/**
 * @arete-module: TraceStoreUtils
 * @arete-risk: moderate
 * @arete-ethics: high
 * @arete-scope: utility
 *
 * @description: Shared helpers for trace store serialization and validation. Split out to
 * avoid circular imports between the trace store factory and SQLite backend.
 *
 * @impact
 * Risk: Validation mistakes can corrupt or reject audit data.
 * Ethics: Maintains integrity of provenance metadata and audit trails.
 */

import type { ResponseMetadata } from '../ethics-core';

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
  // Fail fast on unexpected shapes so we don't store malformed audit data.
  if (!value || typeof value !== 'object') {
    throw new Error(`Trace record "${source}" for response "${responseId}" is invalid (expected object).`);
  }

  const record = value as Record<string, unknown>;
  // Required string fields ensure core audit trail integrity.
  const requiredStringFields: Array<keyof ResponseMetadata> = [
    'responseId',
    'chainHash',
    'staleAfter',
    'licenseContext',
    'modelVersion',
    'provenance',
    'riskTier'
  ];

  for (const field of requiredStringFields) {
    if (typeof record[field] !== 'string' || (record[field] as string).length === 0) {
      throw new Error(`Trace record "${source}" for response "${responseId}" is invalid (missing field ${field}).`);
    }
  }

  if (typeof record.tradeoffCount !== 'number') {
    throw new Error(`Trace record "${source}" for response "${responseId}" is invalid (tradeoffCount must be number).`);
  }

  if (typeof record.confidence !== 'number') {
    throw new Error(`Trace record "${source}" for response "${responseId}" is invalid (confidence must be number).`);
  }

  if (!Array.isArray(record.citations)) {
    throw new Error(`Trace record "${source}" for response "${responseId}" is invalid (citations must be an array).`);
  }

  if (record.imageDescriptions !== undefined) {
    if (!Array.isArray(record.imageDescriptions)) {
      throw new Error(`Trace record "${source}" for response "${responseId}" is invalid (imageDescriptions must be an array).`);
    }
    for (const entry of record.imageDescriptions) {
      if (typeof entry !== 'string') {
        throw new Error(`Trace record "${source}" for response "${responseId}" is invalid (imageDescriptions entries must be strings).`);
      }
    }
  }

  for (const citation of record.citations) {
    if (!citation || typeof citation !== 'object') {
      throw new Error(`Trace record "${source}" for response "${responseId}" is invalid (citation must be object).`);
    }

    const citationRecord = citation as Record<string, unknown>;

    if (typeof citationRecord.title !== 'string') {
      throw new Error(`Trace record "${source}" for response "${responseId}" is invalid (citation title missing).`);
    }

    if (typeof citationRecord.url === 'string') {
      try {
        // Accept JSON payloads that encode URLs as strings, but store validated URL objects.
        citationRecord.url = new URL(citationRecord.url);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Trace record "${source}" for response "${responseId}" is invalid (citation URL malformed: ${errorMessage}).`
        );
      }
    }

    if (!(citationRecord.url instanceof URL)) {
      throw new Error(`Trace record "${source}" for response "${responseId}" is invalid (citation URL missing).`);
    }
  }
}

