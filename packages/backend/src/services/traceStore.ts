/**
 * @description: Initializes trace storage and normalizes metadata for persistence.
 * @arete-scope: utility
 * @arete-module: TraceStoreService
 * @arete-risk: high - Trace persistence failures undermine auditing and trust.
 * @arete-ethics: high - Missing provenance data reduces transparency guarantees.
 */
import type { ResponseMetadata } from '../ethics-core';
import { createTraceStoreFromEnv, type TraceStore } from '../shared/traceStore';
import { logger } from '../shared/logger';

// --- Trace store initialization ---
const createTraceStore = (): TraceStore => createTraceStoreFromEnv();

// --- Trace persistence wrapper ---
const storeTrace = async (traceStore: TraceStore, metadata: ResponseMetadata): Promise<void> => {
  try {
    // --- Response identifier guard ---
    const responseId = metadata.responseId;
    if (!responseId) {
      logger.warn('Missing response identifier for trace storage.');
      return;
    }

    // --- Write-through ---
    await traceStore.upsert(metadata);
    logger.debug(`Trace stored successfully: ${responseId}`);
  } catch (error) {
    // --- Error visibility ---
    logger.error(
      `Failed to store trace for response "${metadata.responseId}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

export { createTraceStore, storeTrace };

