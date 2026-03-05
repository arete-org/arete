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
import { renderTraceCardSvg } from './traceCard/traceCardSvg.js';
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
        // TRACE temperament is optional for now, so we only render/store a card
        // when the metadata actually includes temperament axes.
        if (metadata.temperament) {
            try {
                const traceCardSvg = renderTraceCardSvg({
                    temperament: metadata.temperament,
                    chips: {
                        confidencePercent: Math.round(metadata.confidence * 100),
                        riskTier: metadata.riskTier,
                        tradeoffCount: metadata.tradeoffCount,
                    },
                });
                await traceStore.upsertTraceCardSvg(responseId, traceCardSvg);
                logger.debug(`Trace-card SVG stored successfully: ${responseId}`);
            } catch (error) {
                // Fail-open: trace metadata storage succeeded already.
                logger.warn(
                    `Trace-card SVG storage failed for response "${responseId}": ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }
    } catch (error) {
        // --- Error visibility ---
        logger.error(
            `Failed to store trace for response "${metadata.responseId}": ${error instanceof Error ? error.message : String(error)}`
        );
    }
};

export { createTraceStore, storeTrace };

