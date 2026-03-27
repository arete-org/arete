/**
 * @description: Verifies planner fallback telemetry rollups group counts by reason, surface, and selection source.
 * @footnote-scope: test
 * @footnote-module: PlannerFallbackTelemetryRollupTests
 * @footnote-risk: low - Test gaps here only reduce confidence in fallback telemetry visibility.
 * @footnote-ethics: medium - Broken rollups can hide regression signals in operator review workflows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createPlannerFallbackTelemetryRollup,
    type PlannerFallbackReason,
    type PlannerSelectionSource,
} from '../src/services/plannerFallbackTelemetryRollup.js';

type LoggedSummary = {
    totalEvents: number;
    byClassification: Record<
        'expected_fail_open' | 'regression_candidate',
        number
    >;
    grouped: Array<{
        reason: PlannerFallbackReason;
        surface: 'web' | 'discord';
        selectionSource: PlannerSelectionSource;
        classification: 'expected_fail_open' | 'regression_candidate';
        count: number;
    }>;
    latestEvent: {
        reason: PlannerFallbackReason;
        surface: 'web' | 'discord';
        selectionSource: PlannerSelectionSource;
    };
};

test('rollup emits grouped summary on first event and every configured interval', () => {
    const logs: LoggedSummary[] = [];
    const rollup = createPlannerFallbackTelemetryRollup({
        logger: {
            info: (_message: string, payload: unknown) => {
                logs.push(payload as LoggedSummary);
            },
        },
        emitEvery: 3,
    });

    rollup.record({
        reason: 'request_invalid_or_disabled_profile',
        surface: 'web',
        selectionSource: 'request',
    });
    rollup.record({
        reason: 'planner_invalid_or_disabled_profile',
        surface: 'discord',
        selectionSource: 'planner',
    });
    rollup.record({
        reason: 'request_invalid_or_disabled_profile',
        surface: 'web',
        selectionSource: 'request',
    });

    assert.equal(logs.length, 2);
    assert.equal(logs[0]?.totalEvents, 1);
    assert.equal(logs[1]?.totalEvents, 3);
    assert.equal(logs[1]?.byClassification.expected_fail_open, 2);
    assert.equal(logs[1]?.byClassification.regression_candidate, 1);
    const groupedExpected = logs[1]?.grouped.find(
        (group) =>
            group.reason === 'request_invalid_or_disabled_profile' &&
            group.surface === 'web' &&
            group.selectionSource === 'request'
    );
    assert.equal(groupedExpected?.count, 2);
    assert.equal(groupedExpected?.classification, 'expected_fail_open');
    assert.deepEqual(logs[1]?.latestEvent, {
        reason: 'request_invalid_or_disabled_profile',
        surface: 'web',
        selectionSource: 'request',
    });
});
