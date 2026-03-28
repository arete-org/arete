/**
 * @description: Verifies shared execution timeline summary formatting stays compact and robust across event variants.
 * @footnote-scope: test
 * @footnote-module: ExecutionFormattingTests
 * @footnote-risk: low - Tests only cover deterministic display formatting.
 * @footnote-ethics: medium - Clear timeline summaries improve operator transparency and auditability.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    formatExecutionTimelineSummary,
    type ExecutionEvent,
} from '../src/ethics-core';

test('formatExecutionTimelineSummary includes reasonCode for skipped and failed events', () => {
    const summary = formatExecutionTimelineSummary([
        {
            kind: 'planner',
            status: 'failed',
            reasonCode: 'planner_runtime_error',
            model: 'gpt-5-nano',
        },
        {
            kind: 'tool',
            status: 'skipped',
            toolName: 'web_search',
            reasonCode: 'search_not_supported_by_selected_profile',
            durationMs: 5,
        },
        {
            kind: 'generation',
            status: 'executed',
            model: 'gpt-5-mini',
            durationMs: 22,
        },
    ]);

    assert.equal(
        summary,
        'planner:gpt-5-nano(failed, planner_runtime_error) -> tool:web_search(skipped, search_not_supported_by_selected_profile, 5ms) -> generation:gpt-5-mini(executed, 22ms)'
    );
});

test('formatExecutionTimelineSummary handles missing optional fields', () => {
    const events: ExecutionEvent[] = [
        {
            kind: 'planner',
            status: 'executed',
        },
        {
            kind: 'evaluator',
            status: 'executed',
            evaluator: {
                mode: 'observe_only',
                riskTier: 'Low',
                provenance: 'Inferred',
                breaker: {
                    action: 'allow',
                    ruleId: null,
                },
                breakerTriggered: false,
            },
        },
        {
            kind: 'tool',
            status: 'executed',
            toolName: 'web_search',
        },
        {
            kind: 'generation',
            status: 'executed',
        },
    ];

    assert.equal(
        formatExecutionTimelineSummary(events),
        'planner:unknown(executed) -> evaluator:Low/Inferred/allow(executed) -> tool:web_search(executed) -> generation:unknown(executed)'
    );
});

test('formatExecutionTimelineSummary includes evaluator breaker rule context for non-allow actions', () => {
    const summary = formatExecutionTimelineSummary([
        {
            kind: 'evaluator',
            status: 'executed',
            evaluator: {
                mode: 'observe_only',
                riskTier: 'High',
                provenance: 'Inferred',
                breaker: {
                    action: 'block',
                    ruleId: 'risk.safety.weaponization_request.v1',
                    reasonCode: 'weaponization_request',
                    reason: 'Deterministic weaponization-request rule matched.',
                },
                breakerTriggered: true,
                breakerReason: 'Deterministic weaponization-request rule matched.',
            },
            durationMs: 4,
        },
    ]);

    assert.equal(
        summary,
        'evaluator:High/Inferred/block/risk.safety.weaponization_request.v1/weaponization_request(executed, 4ms)'
    );
});

test('formatExecutionTimelineSummary returns null for missing or empty timelines', () => {
    assert.equal(formatExecutionTimelineSummary(undefined), null);
    assert.equal(formatExecutionTimelineSummary([]), null);
});
