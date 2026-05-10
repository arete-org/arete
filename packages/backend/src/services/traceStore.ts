/**
 * @description: Initializes trace storage and normalizes metadata for persistence.
 * @footnote-scope: utility
 * @footnote-module: TraceStoreService
 * @footnote-risk: high - Trace persistence failures undermine auditing and trust.
 * @footnote-ethics: high - Missing provenance data reduces transparency guarantees.
 */
import type { ResponseMetadata } from '@footnote/contracts/policy';
import {
    createTraceStoreFromConfig,
    type TraceStore,
} from '../storage/traces/traceStore.js';
import type { LangfuseShadowMirror } from './langfuseShadowExporter.js';
import { logger } from '../utils/logger.js';

let traceMetadataMirror: LangfuseShadowMirror | null = null;

export const configureTraceMetadataMirror = (
    mirror: LangfuseShadowMirror | null
): void => {
    traceMetadataMirror = mirror;
};

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

        if (traceMetadataMirror) {
            try {
                await traceMetadataMirror(metadata);
            } catch (error) {
                logger.warn(
                    `Langfuse shadow mirror failed for response "${responseId}": ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }

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
