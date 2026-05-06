/**
 * @description: Verifies workflow profile registry lookup and profile output boundaries.
 * @footnote-scope: test
 * @footnote-module: WorkflowProfileRegistryTests
 * @footnote-risk: medium - Registry mismatches can route runtime to incorrect workflow behavior.
 * @footnote-ethics: medium - Incorrect fallback handling can misrepresent execution intent to operators.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    deriveReviewIntensityFromWorkflowBehavior,
    resolveWorkflowModeDecision,
    resolveWorkflowProfileRegistry,
    resolveWorkflowRuntimeConfig,
} from '../src/services/workflowProfileRegistry.js';

test('resolveWorkflowProfileRegistry resolves known profile ids and fail-open fallback for unknown ids', () => {
    const reviewed = resolveWorkflowProfileRegistry('bounded-review');
    assert.equal(reviewed.isKnownProfileId, true);
    assert.equal(reviewed.runtimeProfile.profileId, 'bounded-review');
    assert.equal(reviewed.profileContract.profileId, 'bounded-review');
    assert.equal(
        reviewed.runtimeProfile.workflowName,
        'message_with_review_loop'
    );
    assert.equal(
        reviewed.profileContract.workflowName,
        'message_with_review_loop'
    );

    const unknownFallback = resolveWorkflowProfileRegistry(
        'unrecognized-workflow-profile'
    );
    assert.equal(unknownFallback.isKnownProfileId, false);
    assert.equal(
        unknownFallback.requestedProfileId,
        'unrecognized-workflow-profile'
    );
    assert.equal(unknownFallback.runtimeProfile.profileId, 'bounded-review');
    assert.equal(unknownFallback.profileContract.profileId, 'bounded-review');
    assert.equal(
        unknownFallback.runtimeProfile.workflowName,
        'message_with_review_loop'
    );
    assert.equal(
        unknownFallback.profileContract.workflowName,
        'message_with_review_loop'
    );
});

test('resolveWorkflowProfileRegistry trims profile ids before lookup', () => {
    const trimmedProfile = resolveWorkflowProfileRegistry('  bounded-review  ');
    assert.equal(trimmedProfile.isKnownProfileId, true);
    assert.equal(trimmedProfile.requestedProfileId, 'bounded-review');
    assert.equal(trimmedProfile.runtimeProfile.profileId, 'bounded-review');
    assert.equal(trimmedProfile.profileContract.profileId, 'bounded-review');
});

test('resolveWorkflowProfileRegistry keeps public contract serializable while runtime profile includes hooks', () => {
    const resolution = resolveWorkflowProfileRegistry('bounded-review');

    assert.equal(
        typeof resolution.runtimeProfile.requiredHooks.forceWorkflowExecution,
        'boolean'
    );
    assert.equal(
        typeof resolution.runtimeProfile.requiredHooks.canEmitGeneration,
        'function'
    );
    assert.equal(
        typeof resolution.runtimeProfile.requiredHooks.classifyNoGeneration,
        'function'
    );
    assert.equal(typeof resolution.profileContract.profileId, 'string');
    assert.equal(
        Object.prototype.hasOwnProperty.call(
            resolution.profileContract,
            'requiredHooks'
        ),
        false
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(
            resolution.profileContract,
            'parseReviewDecision'
        ),
        false
    );

    const serializedContract = JSON.parse(
        JSON.stringify(resolution.profileContract)
    ) as Record<string, unknown>;
    assert.equal(serializedContract.profileId, 'bounded-review');
    assert.equal(
        Object.prototype.hasOwnProperty.call(
            serializedContract,
            'requiredHooks'
        ),
        false
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(
            serializedContract,
            'parseReviewDecision'
        ),
        false
    );
});

test('resolveWorkflowRuntimeConfig applies reviewed workflow defaults and review-loop gating', () => {
    const balancedRuntimeConfig = resolveWorkflowRuntimeConfig({
        modeId: 'balanced',
        reviewLoopEnabled: true,
        maxIterations: 5,
        maxDurationMs: 9000,
    });
    assert.equal(balancedRuntimeConfig.profileId, 'bounded-review');
    assert.equal(balancedRuntimeConfig.workflowExecutionEnabled, true);
    assert.equal(
        balancedRuntimeConfig.workflowExecutionLimits.maxWorkflowSteps,
        4
    );
    assert.equal(
        balancedRuntimeConfig.workflowExecutionLimits.maxPlanCycles,
        1
    );
    assert.equal(
        balancedRuntimeConfig.workflowExecutionLimits.maxReviewCycles,
        1
    );
    assert.equal(
        balancedRuntimeConfig.workflowExecutionLimits.maxDeliberationCalls,
        2
    );
    assert.equal(
        balancedRuntimeConfig.workflowExecutionLimits.maxDurationMs,
        9000
    );

    const groundedRuntimeConfig = resolveWorkflowRuntimeConfig({
        modeId: 'grounded',
        reviewLoopEnabled: false,
        maxIterations: 5,
        maxDurationMs: 9000,
    });
    assert.equal(groundedRuntimeConfig.profileId, 'bounded-review');
    assert.equal(groundedRuntimeConfig.workflowExecutionEnabled, false);
    assert.equal(
        groundedRuntimeConfig.workflowExecutionLimits.maxWorkflowSteps,
        8
    );
    assert.equal(
        groundedRuntimeConfig.workflowExecutionLimits.maxPlanCycles,
        1
    );
    assert.equal(
        groundedRuntimeConfig.workflowExecutionLimits.maxReviewCycles,
        3
    );
    assert.equal(
        groundedRuntimeConfig.workflowExecutionLimits.maxDeliberationCalls,
        4
    );
    assert.equal(
        groundedRuntimeConfig.workflowExecutionLimits.maxDurationMs,
        9000
    );
});

test('resolveWorkflowModeDecision maps requested mode ids and emits inspectable routing behavior', () => {
    const requested = resolveWorkflowModeDecision({
        modeId: 'balanced',
    });
    assert.equal(requested.isKnownRequestedModeId, true);
    assert.equal(requested.modeDecision.modeId, 'balanced');
    assert.equal(requested.modeDecision.initial_mode, 'balanced');
    assert.equal(requested.modeDecision.selectedBy, 'requested_mode');
    assert.equal(
        requested.modeDecision.behavior.executionContractPresetId,
        'balanced'
    );
    assert.equal(
        requested.modeDecision.behavior.workflowProfileId,
        'bounded-review'
    );
    assert.equal(requested.modeDecision.behavior.reviewPass, 'included');
    assert.equal(requested.modeDecision.behavior.reviseStep, 'allowed');
    assert.equal(requested.modeDecision.behavior.evidencePosture, 'balanced');
});

test('resolveWorkflowModeDecision fails open by inferring from execution contract and then defaulting', () => {
    const inferred = resolveWorkflowModeDecision({
        modeId: 'unknown-mode',
        executionContractResponseMode: 'quality_grounded',
    });
    assert.equal(inferred.isKnownRequestedModeId, false);
    assert.equal(inferred.modeDecision.modeId, 'grounded');
    assert.equal(inferred.modeDecision.initial_mode, 'grounded');
    assert.equal(
        inferred.modeDecision.selectedBy,
        'inferred_from_execution_contract'
    );
    assert.equal(
        inferred.modeDecision.behavior.executionContractPresetId,
        'quality-grounded'
    );

    const fallbackDefault = resolveWorkflowModeDecision({
        modeId: 'unknown-mode',
    });
    assert.equal(fallbackDefault.modeDecision.modeId, 'grounded');
    assert.equal(fallbackDefault.modeDecision.initial_mode, 'grounded');
    assert.equal(fallbackDefault.modeDecision.selectedBy, 'fail_open_default');
});

test('resolveWorkflowModeDecision treats non-canonical mode ids as unknown and fails open', () => {
    const legacyFast = resolveWorkflowModeDecision({
        modeId: 'generate-only',
    });
    assert.equal(legacyFast.isKnownRequestedModeId, false);
    assert.equal(legacyFast.modeDecision.modeId, 'grounded');
    assert.equal(legacyFast.modeDecision.initial_mode, 'grounded');
    assert.equal(legacyFast.modeDecision.selectedBy, 'fail_open_default');
    assert.equal(legacyFast.modeDecision.requestedModeId, 'generate-only');
});

test('resolveWorkflowRuntimeConfig exposes bounded workflow-owned escalation metadata', () => {
    const config = resolveWorkflowRuntimeConfig({
        modeId: 'balanced',
        reviewLoopEnabled: true,
        maxIterations: 3,
        maxDurationMs: 9000,
        modeEscalationRequest: {
            targetModeId: 'grounded',
            reason: 'retrieval required for grounded evidence posture',
        },
    });

    assert.equal(config.modeDecision.initial_mode, 'balanced');
    assert.equal(config.modeDecision.escalated_mode, 'grounded');
    assert.equal(
        config.modeDecision.escalation_reason,
        'retrieval required for grounded evidence posture'
    );
    assert.equal(config.modeDecision.modeId, 'grounded');
    assert.equal(config.modeDecision.selectedBy, 'workflow_mode_escalation');
});

test('resolveWorkflowRuntimeConfig rejects downward mode changes and keeps initial behavior', () => {
    const config = resolveWorkflowRuntimeConfig({
        modeId: 'grounded',
        reviewLoopEnabled: true,
        maxIterations: 3,
        maxDurationMs: 9000,
        modeEscalationRequest: {
            targetModeId: 'balanced',
            reason: 'attempt downgrade',
        },
    });

    assert.equal(config.modeDecision.modeId, 'grounded');
    assert.equal(config.modeDecision.selectedBy, 'requested_mode');
    assert.equal(
        config.modeDecision.behavior.executionContractPresetId,
        'quality-grounded'
    );
    assert.equal(config.modeDecision.escalated_mode, undefined);
    assert.equal(config.modeDecision.escalation_reason, undefined);
});

test('resolveWorkflowRuntimeConfig fails open when escalation target mode id is malformed', () => {
    const config = resolveWorkflowRuntimeConfig({
        modeId: 'balanced',
        reviewLoopEnabled: true,
        maxIterations: 3,
        maxDurationMs: 9000,
        modeEscalationRequest: {
            targetModeId: 'not-a-mode',
            reason: 'unsafe runtime input',
        } as unknown as {
            targetModeId: 'balanced' | 'grounded';
            reason: string;
        },
    });

    assert.equal(config.modeDecision.modeId, 'balanced');
    assert.equal(config.modeDecision.selectedBy, 'requested_mode');
    assert.equal(config.modeDecision.escalated_mode, undefined);
    assert.equal(config.modeDecision.escalation_reason, undefined);
});

test('deriveReviewIntensityFromWorkflowBehavior centralizes review intensity mapping', () => {
    assert.equal(
        deriveReviewIntensityFromWorkflowBehavior({
            executionContractPresetId: 'balanced',
            workflowProfileClass: 'reviewed',
            workflowProfileId: 'bounded-review',
            workflowExecution: 'always',
            reviewPass: 'included',
            reviseStep: 'allowed',
            evidencePosture: 'balanced',
            maxWorkflowSteps: 1,
            maxPlanCycles: 1,
            maxReviewCycles: 0,
            maxDeliberationCalls: 0,
        }),
        'none'
    );
    assert.equal(
        deriveReviewIntensityFromWorkflowBehavior({
            executionContractPresetId: 'balanced',
            workflowProfileClass: 'reviewed',
            workflowProfileId: 'bounded-review',
            workflowExecution: 'always',
            reviewPass: 'included',
            reviseStep: 'allowed',
            evidencePosture: 'balanced',
            maxWorkflowSteps: 4,
            maxPlanCycles: 1,
            maxReviewCycles: 1,
            maxDeliberationCalls: 1,
        }),
        'light'
    );
    assert.equal(
        deriveReviewIntensityFromWorkflowBehavior({
            executionContractPresetId: 'balanced',
            workflowProfileClass: 'reviewed',
            workflowProfileId: 'bounded-review',
            workflowExecution: 'always',
            reviewPass: 'included',
            reviseStep: 'allowed',
            evidencePosture: 'balanced',
            maxWorkflowSteps: 4,
            maxPlanCycles: 1,
            maxReviewCycles: 2,
            maxDeliberationCalls: 2,
        }),
        'moderate'
    );
    assert.equal(
        deriveReviewIntensityFromWorkflowBehavior({
            executionContractPresetId: 'quality-grounded',
            workflowProfileClass: 'reviewed',
            workflowProfileId: 'bounded-review',
            workflowExecution: 'policy_gated',
            reviewPass: 'included',
            reviseStep: 'allowed',
            evidencePosture: 'strict',
            maxWorkflowSteps: 8,
            maxPlanCycles: 1,
            maxReviewCycles: 4,
            maxDeliberationCalls: 4,
        }),
        'high'
    );
});

test('resolveWorkflowRuntimeConfig keeps maxDeliberationCalls compatibility mapped from plan/review cycles', () => {
    const balanced = resolveWorkflowRuntimeConfig({
        modeId: 'balanced',
        reviewLoopEnabled: true,
        maxIterations: 5,
        maxDurationMs: 9000,
    });
    assert.equal(
        balanced.workflowExecutionLimits.maxDeliberationCalls,
        (balanced.workflowExecutionLimits.maxPlanCycles ?? 0) +
            (balanced.workflowExecutionLimits.maxReviewCycles ?? 0)
    );
});
