/**
 * @description: Shared execution timeline formatting for web and Discord provenance surfaces.
 * @footnote-scope: interface
 * @footnote-module: ExecutionTimelineFormatting
 * @footnote-risk: low - Formatting mistakes may confuse operator visibility but do not affect runtime behavior.
 * @footnote-ethics: medium - Clear execution rendering supports transparency across user-facing surfaces.
 */
import type { ExecutionEvent } from './types.js';

const formatExecutionEvent = (event: ExecutionEvent): string => {
    const durationSuffix =
        event.durationMs !== undefined ? `, ${event.durationMs}ms` : '';
    const reasonSuffix =
        event.status === 'executed' || !event.reasonCode
            ? ''
            : `, ${event.reasonCode}`;
    if (event.kind === 'tool') {
        const tool = event.toolName?.trim() || 'tool';
        return `${event.kind}:${tool}(${event.status}${reasonSuffix}${durationSuffix})`;
    }
    if (event.kind === 'evaluator') {
        const evaluatorSummary = event.evaluator
            ? `${event.evaluator.riskTier}/${event.evaluator.provenance}`
            : 'decision';
        return `${event.kind}:${evaluatorSummary}(${event.status}${reasonSuffix}${durationSuffix})`;
    }

    // Prefer model first because that is the most user-visible execution
    // identifier. Fall back to profile/provider ids for partial traces.
    const modelOrProfile =
        event.model ??
        event.effectiveProfileId ??
        event.profileId ??
        event.originalProfileId ??
        event.provider ??
        'unknown';
    return `${event.kind}:${modelOrProfile}(${event.status}${reasonSuffix}${durationSuffix})`;
};

/**
 * Formats execution[] into a compact one-line summary.
 */
export const formatExecutionTimelineSummary = (
    execution: ExecutionEvent[] | undefined
): string | null => {
    if (!execution || execution.length === 0) {
        return null;
    }

    return execution.map(formatExecutionEvent).join(' -> ');
};
