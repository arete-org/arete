/**
 * @description: Centralizes TRACE score validation and normalization helpers for Discord-bot metadata pipelines.
 * @footnote-scope: utility
 * @footnote-module: TraceAxisScoreUtils
 * @footnote-risk: low - Incorrect normalization can mis-render TRACE chips and temperament values.
 * @footnote-ethics: medium - TRACE scoring affects transparency signals shown to users.
 */
import type { TraceAxisScore } from '@footnote/contracts/ethics-core';

export const isTraceAxisScore = (value: unknown): value is TraceAxisScore =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5;

export const normalizeTraceAxisScoreWithStringParsing = (
    value: unknown
): TraceAxisScore | undefined => {
    if (typeof value === 'number') {
        return isTraceAxisScore(value) ? value : undefined;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!/^\d+$/.test(trimmed)) {
            return undefined;
        }
        const parsed = Number.parseInt(trimmed, 10);
        return isTraceAxisScore(parsed) ? parsed : undefined;
    }

    return undefined;
};
