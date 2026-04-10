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
                authorityLevel: 'observe',
                mode: 'observe_only',
                provenance: 'Inferred',
                safetyDecision: {
                    action: 'allow',
                    safetyTier: 'Low',
                    ruleId: null,
                },
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
        'planner:unknown(executed) -> evaluator:observe/Low/Inferred/allow(executed) -> tool:web_search(executed) -> generation:unknown(executed)'
    );
});

test('formatExecutionTimelineSummary includes evaluator breaker rule context for non-allow actions', () => {
    const summary = formatExecutionTimelineSummary([
        {
            kind: 'evaluator',
            status: 'executed',
            evaluator: {
                authorityLevel: 'influence',
                mode: 'observe_only',
                provenance: 'Inferred',
                safetyDecision: {
                    action: 'block',
                    safetyTier: 'High',
                    ruleId: 'safety.weaponization_request.v1',
                    reasonCode: 'weaponization_request',
                    reason: 'Deterministic weaponization-request rule matched.',
                },
            },
            durationMs: 4,
        },
    ]);

    assert.equal(
        summary,
        'evaluator:influence/High/Inferred/block/safety.weaponization_request.v1/weaponization_request(executed, 4ms)'
    );
});

test('formatExecutionTimelineSummary infers influence for legacy observe-only non-allow evaluator payloads', () => {
    const legacyEvaluatorEvent = {
        kind: 'evaluator',
        status: 'executed',
        evaluator: {
            mode: 'observe_only',
            provenance: 'Inferred',
            safetyDecision: {
                action: 'block',
                safetyTier: 'High',
                ruleId: 'safety.weaponization_request.v1',
                reasonCode: 'weaponization_request',
                reason: 'Deterministic weaponization-request rule matched.',
            },
        },
    } as unknown as ExecutionEvent;
    const summary = formatExecutionTimelineSummary([legacyEvaluatorEvent]);

    assert.equal(
        summary,
        'evaluator:influence/High/Inferred/block/safety.weaponization_request.v1/weaponization_request(executed)'
    );
});

test('formatExecutionTimelineSummary falls back to decision label for malformed evaluator payloads', () => {
    const malformedEvent = {
        kind: 'evaluator',
        status: 'executed',
        evaluator: {
            decision: 'allow',
            provenance: 'Retrieved',
        },
    } as unknown as ExecutionEvent;

    assert.equal(
        formatExecutionTimelineSummary([malformedEvent]),
        'evaluator:decision(executed)'
    );
});

test('formatExecutionTimelineSummary returns null for missing or empty timelines', () => {
    assert.equal(formatExecutionTimelineSummary(undefined), null);
    assert.equal(formatExecutionTimelineSummary([]), null);
});
