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
    if (event.kind === 'tool') {
        const tool = event.toolName ?? 'tool';
        return `${event.kind}:${tool}(${event.status}${durationSuffix})`;
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
    return `${event.kind}:${modelOrProfile}(${event.status}${durationSuffix})`;
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
