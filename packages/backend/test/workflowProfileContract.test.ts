/**
 * @description: Verifies no-generation handling resolution behavior.
 * @footnote-scope: test
 * @footnote-module: WorkflowProfileContractTests
 * @footnote-risk: medium - Missing mapping coverage can cause surfaced/internal no-generation drift.
 * @footnote-ethics: high - Incorrect mapping can hide blocked states or misstate provenance to callers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { WorkflowTerminationReason } from '@footnote/contracts/ethics-core';
import { resolveNoGenerationHandlingFromTermination } from '../src/services/workflowProfileContract.js';

test('resolveNoGenerationHandlingFromTermination maps every no-generation termination reason deterministically', () => {
    const mappedCases: Array<{
        terminationReason: WorkflowTerminationReason;
        generationEnabledByPolicy: boolean;
        expectedReasonCode:
            | 'blocked_by_policy_before_generate'
            | 'generation_disabled_by_profile'
            | 'budget_exhausted_steps_before_generate'
            | 'budget_exhausted_tokens_before_generate'
            | 'budget_exhausted_time_before_generate'
            | 'executor_error_before_generate';
        expectedTerminationReason: WorkflowTerminationReason;
        expectedRuntimeAction:
            | 'return_no_generation'
            | 'run_fallback_generation';
    }> = [
        {
            terminationReason: 'transition_blocked_by_policy',
            generationEnabledByPolicy: true,
            expectedReasonCode: 'blocked_by_policy_before_generate',
            expectedTerminationReason: 'transition_blocked_by_policy',
            expectedRuntimeAction: 'return_no_generation',
        },
        {
            terminationReason: 'transition_blocked_by_policy',
            generationEnabledByPolicy: false,
            expectedReasonCode: 'generation_disabled_by_profile',
            expectedTerminationReason: 'transition_blocked_by_policy',
            expectedRuntimeAction: 'return_no_generation',
        },
        {
            terminationReason: 'budget_exhausted_steps',
            generationEnabledByPolicy: true,
            expectedReasonCode: 'budget_exhausted_steps_before_generate',
            expectedTerminationReason: 'budget_exhausted_steps',
            expectedRuntimeAction: 'run_fallback_generation',
        },
        {
            terminationReason: 'budget_exhausted_steps',
            generationEnabledByPolicy: false,
            expectedReasonCode: 'generation_disabled_by_profile',
            expectedTerminationReason: 'transition_blocked_by_policy',
            expectedRuntimeAction: 'return_no_generation',
        },
        {
            terminationReason: 'budget_exhausted_tokens',
            generationEnabledByPolicy: true,
            expectedReasonCode: 'budget_exhausted_tokens_before_generate',
            expectedTerminationReason: 'budget_exhausted_tokens',
            expectedRuntimeAction: 'run_fallback_generation',
        },
        {
            terminationReason: 'budget_exhausted_tokens',
            generationEnabledByPolicy: false,
            expectedReasonCode: 'generation_disabled_by_profile',
            expectedTerminationReason: 'transition_blocked_by_policy',
            expectedRuntimeAction: 'return_no_generation',
        },
        {
            terminationReason: 'budget_exhausted_time',
            generationEnabledByPolicy: true,
            expectedReasonCode: 'budget_exhausted_time_before_generate',
            expectedTerminationReason: 'budget_exhausted_time',
            expectedRuntimeAction: 'run_fallback_generation',
        },
        {
            terminationReason: 'budget_exhausted_time',
            generationEnabledByPolicy: false,
            expectedReasonCode: 'generation_disabled_by_profile',
            expectedTerminationReason: 'transition_blocked_by_policy',
            expectedRuntimeAction: 'return_no_generation',
        },
        {
            terminationReason: 'executor_error_fail_open',
            generationEnabledByPolicy: true,
            expectedReasonCode: 'executor_error_before_generate',
            expectedTerminationReason: 'executor_error_fail_open',
            expectedRuntimeAction: 'return_no_generation',
        },
    ];

    for (const mappedCase of mappedCases) {
        const resolution = resolveNoGenerationHandlingFromTermination({
            terminationReason: mappedCase.terminationReason,
            generationEnabledByPolicy: mappedCase.generationEnabledByPolicy,
        });

        assert.equal(resolution.kind, 'mapped');
        if (resolution.kind === 'mapped') {
            assert.equal(resolution.reasonCode, mappedCase.expectedReasonCode);
            assert.equal(
                resolution.handling.runtimeAction,
                mappedCase.expectedRuntimeAction
            );
            assert.equal(
                resolution.handling.terminationReason,
                mappedCase.expectedTerminationReason
            );
        }
    }
});

test('resolveNoGenerationHandlingFromTermination marks unsupported termination reasons explicitly', () => {
    const unsupportedReasons: WorkflowTerminationReason[] = [
        'goal_satisfied',
        'max_tool_calls_reached',
        'max_deliberation_calls_reached',
    ];

    for (const terminationReason of unsupportedReasons) {
        const resolution = resolveNoGenerationHandlingFromTermination({
            terminationReason,
            generationEnabledByPolicy: true,
        });

        assert.equal(resolution.kind, 'unsupported_termination_reason');
        if (resolution.kind === 'unsupported_termination_reason') {
            assert.equal(resolution.terminationReason, terminationReason);
        }
    }
});
