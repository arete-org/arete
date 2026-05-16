/**
 * @description: Shared TRACE signal mapping helpers for workflow assess and planner lineage records.
 * @footnote-scope: utility
 * @footnote-module: TraceAlignmentSignals
 * @footnote-risk: low - Mapper drift could mislabel TRACE signals across workflow and metadata wiring.
 * @footnote-ethics: medium - TRACE alignment labels inform user transparency about intended vs delivered posture.
 */
import type {
    PartialResponseTemperament,
    StepRecord,
    TraceAxisScore,
} from '@footnote/contracts/policy';
import {
    TRACE_ASSESS_FINAL_TEMPERAMENT_SIGNAL_KEYS,
    TRACE_PLANNER_TARGET_TEMPERAMENT_SIGNAL_KEYS,
    TRACE_TEMPERAMENT_AXIS_KEYS,
    isTraceTemperamentEqual,
} from '@footnote/contracts/policy';

export const isTraceAxisScore = (value: unknown): value is TraceAxisScore =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5;

export const hasDifferentTemperament = (
    before: PartialResponseTemperament | undefined,
    after: PartialResponseTemperament | undefined
): boolean => !isTraceTemperamentEqual(before, after);

export const toPlannerTraceTargetSignals = (
    temperament: PartialResponseTemperament | undefined
): Record<string, TraceAxisScore> => {
    const signals: Record<string, TraceAxisScore> = {};
    if (temperament === undefined) {
        return signals;
    }

    for (const axisKey of TRACE_TEMPERAMENT_AXIS_KEYS) {
        const score = temperament[axisKey];
        if (isTraceAxisScore(score)) {
            signals[TRACE_PLANNER_TARGET_TEMPERAMENT_SIGNAL_KEYS[axisKey]] =
                score;
        }
    }

    return signals;
};

export const toAssessFinalTemperamentSignals = (
    temperament: PartialResponseTemperament | undefined
): Record<string, TraceAxisScore> => {
    const signals: Record<string, TraceAxisScore> = {};
    if (temperament === undefined) {
        return signals;
    }

    for (const axisKey of TRACE_TEMPERAMENT_AXIS_KEYS) {
        const score = temperament[axisKey];
        if (isTraceAxisScore(score)) {
            signals[TRACE_ASSESS_FINAL_TEMPERAMENT_SIGNAL_KEYS[axisKey]] =
                score;
        }
    }

    return signals;
};

export const fromAssessSignalsToFinalTemperament = (
    signals: StepRecord['outcome']['signals'] | undefined
): PartialResponseTemperament | undefined => {
    if (!signals) {
        return undefined;
    }

    const temperament: PartialResponseTemperament = {};
    for (const axisKey of TRACE_TEMPERAMENT_AXIS_KEYS) {
        const signalKey = TRACE_ASSESS_FINAL_TEMPERAMENT_SIGNAL_KEYS[axisKey];
        const score = signals[signalKey];
        if (isTraceAxisScore(score)) {
            temperament[axisKey] = score;
        }
    }

    return Object.keys(temperament).length > 0 ? temperament : undefined;
};
