/**
 * @description: Initializes trace storage and normalizes metadata for persistence.
 * @footnote-scope: utility
 * @footnote-module: TraceStoreService
 * @footnote-risk: high - Trace persistence failures undermine auditing and trust.
 * @footnote-ethics: high - Missing provenance data reduces transparency guarantees.
 */
import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import {
    createTraceStoreFromConfig,
    type TraceStore,
} from '../storage/traces/traceStore.js';
import { logger } from '../utils/logger.js';

// --- Trace store initialization ---
const createTraceStore = (): TraceStore => createTraceStoreFromConfig();

// --- Trace persistence wrapper ---
const storeTrace = async (
    traceStore: TraceStore,
    metadata: ResponseMetadata
): Promise<void> => {
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

        // --- Optional trace-card persistence ---
        // Trace-card generation stays out of this write path so trace storage
        // remains lightweight and fail-open even when rendering dependencies
        // or image generation are unavailable.
        if (Object.keys(metadata.trace_final).length > 0) {
            logger.debug(
                `Deferring trace-card generation to trace-card handler path for "${responseId}".`
            );
        }
    } catch (error) {
        // --- Error visibility ---
        logger.error(
            `Failed to store trace for response "${metadata.responseId}": ${error instanceof Error ? error.message : String(error)}`
        );
    }
};

export { createTraceStore, storeTrace };
