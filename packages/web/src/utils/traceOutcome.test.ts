/**
 * @description: Verifies trace run-outcome summary mapping from workflow and execution metadata.
 * @footnote-scope: test
 * @footnote-module: TraceOutcomeSummaryTests
 * @footnote-risk: low - Tests validate read-only summary derivation logic.
 * @footnote-ethics: medium - Ensures UI outcome copy stays aligned with backend-owned runtime facts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type {
    ExecutionEvent,
    ResponseMetadata,
    WorkflowRecord,
} from '@footnote/contracts/ethics-core';
import { buildRunOutcomeSummary } from './traceOutcome.js';

const createWorkflow = (
    terminationReason: WorkflowRecord['terminationReason']
): WorkflowRecord => ({
    workflowId: 'wf_123',
    workflowName: 'bounded-review',
    status: terminationReason === 'goal_satisfied' ? 'completed' : 'degraded',
    terminationReason,
    stepCount: 0,
    maxSteps: 4,
    maxDurationMs: 5000,
    steps: [],
});

const createSource = ({
    workflow,
    execution,
}: {
    workflow?: ResponseMetadata['workflow'];
    execution?: ResponseMetadata['execution'];
}): {
    workflow?: ResponseMetadata['workflow'];
    execution?: ResponseMetadata['execution'];
} => ({
    workflow,
    execution,
});

test('buildRunOutcomeSummary returns completed for goal_satisfied termination', () => {
    const summary = buildRunOutcomeSummary(
        createSource({
            workflow: createWorkflow('goal_satisfied'),
        })
    );
    assert.equal(summary?.category, 'completed');
    assert.equal(summary?.reasonCode, 'goal_satisfied');
    assert.equal(summary?.headline, 'Completed');
    assert.equal(
        summary?.explanation,
        'Workflow reached its goal-satisfied termination path.'
    );
});

test('buildRunOutcomeSummary returns stopped for workflow budget limits', () => {
    const summary = buildRunOutcomeSummary(
        createSource({
            workflow: createWorkflow('budget_exhausted_steps'),
        })
    );
    assert.equal(summary?.category, 'stopped');
    assert.equal(summary?.reasonCode, 'budget_exhausted_steps');
    assert.equal(summary?.headline, 'Stopped');
    assert.equal(
        summary?.explanation,
        'Workflow stopped after reaching the configured step budget.'
    );
});

test('buildRunOutcomeSummary preserves fallback signal when stop reason exists', () => {
    const summary = buildRunOutcomeSummary(
        createSource({
            workflow: createWorkflow('budget_exhausted_steps'),
            execution: [
                {
                    kind: 'tool',
                    toolName: 'web_search',
                    status: 'executed',
                    reasonCode: 'search_rerouted_to_fallback_profile',
                },
            ],
        })
    );
    assert.equal(summary?.category, 'stopped');
    assert.equal(summary?.reasonCode, 'budget_exhausted_steps');
    assert.equal(
        summary?.secondaryReasonCode,
        'search_rerouted_to_fallback_profile'
    );
    assert.equal(summary?.headline, 'Stopped');
    assert.equal(
        summary?.explanation,
        'Workflow stopped after reaching the configured step budget. A fallback signal was also recorded (search_rerouted_to_fallback_profile).'
    );
});

test('buildRunOutcomeSummary returns fallback for explicit reroute reason', () => {
    const execution: ExecutionEvent[] = [
        {
            kind: 'tool',
            toolName: 'web_search',
            status: 'executed',
            reasonCode: 'search_rerouted_to_fallback_profile',
        },
    ];
    const summary = buildRunOutcomeSummary(
        createSource({
            execution,
        })
    );
    assert.equal(summary?.category, 'fell_back');
    assert.equal(summary?.reasonCode, 'search_rerouted_to_fallback_profile');
    assert.equal(summary?.headline, 'Fell back');
    assert.equal(
        summary?.explanation,
        'Search execution was rerouted to a fallback profile.'
    );
});

test('buildRunOutcomeSummary returns fallback without synthetic reason code for planner contract fallback', () => {
    const execution: ExecutionEvent[] = [
        {
            kind: 'planner',
            status: 'executed',
            purpose: 'chat_orchestrator_action_selection',
            contractType: 'fallback',
            applyOutcome: 'applied',
            mattered: false,
            matteredControlIds: [],
        },
    ];
    const summary = buildRunOutcomeSummary(
        createSource({
            execution,
        })
    );
    assert.equal(summary?.category, 'fell_back');
    assert.equal(summary?.reasonCode, undefined);
    assert.equal(summary?.headline, 'Fell back');
    assert.equal(
        summary?.explanation,
        'Fallback planner-contract metadata is present in this trace.'
    );
});

test('buildRunOutcomeSummary returns skipped for explicit skipped reason', () => {
    const execution: ExecutionEvent[] = [
        {
            kind: 'tool',
            toolName: 'web_search',
            status: 'skipped',
            reasonCode: 'search_not_supported_by_selected_profile',
        },
    ];
    const summary = buildRunOutcomeSummary(
        createSource({
            execution,
        })
    );
    assert.equal(summary?.category, 'skipped');
    assert.equal(
        summary?.reasonCode,
        'search_not_supported_by_selected_profile'
    );
    assert.equal(summary?.headline, 'Skipped');
    assert.equal(
        summary?.explanation,
        'A search step was skipped because the selected profile does not support search.'
    );
});

test('buildRunOutcomeSummary returns unknown for metadata without canonical reason', () => {
    const execution: ExecutionEvent[] = [
        {
            kind: 'tool',
            toolName: 'web_search',
            status: 'executed',
        },
    ];
    const summary = buildRunOutcomeSummary(
        createSource({
            execution,
        })
    );
    assert.equal(summary?.category, 'unknown');
    assert.equal(summary?.headline, 'Outcome not fully recorded');
    assert.equal(
        summary?.explanation,
        'Execution metadata exists, but no canonical completion, stop, skip, or fallback reason was recorded.'
    );
});

test('buildRunOutcomeSummary returns null when trace has no workflow or execution metadata', () => {
    const summary = buildRunOutcomeSummary(
        createSource({
            workflow: undefined,
            execution: undefined,
        })
    );
    assert.equal(summary, null);
});
