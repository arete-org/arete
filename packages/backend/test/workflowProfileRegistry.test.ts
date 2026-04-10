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
    const generateOnly = resolveWorkflowProfileRegistry('generate-only');
    assert.equal(generateOnly.isKnownProfileId, true);
    assert.equal(generateOnly.runtimeProfile.profileId, 'generate-only');
    assert.equal(generateOnly.profileContract.profileId, 'generate-only');
    assert.equal(
        generateOnly.runtimeProfile.workflowName,
        'message_generate_only'
    );
    assert.equal(
        generateOnly.profileContract.workflowName,
        'message_generate_only'
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
    const trimmedProfile = resolveWorkflowProfileRegistry('  generate-only  ');
    assert.equal(trimmedProfile.isKnownProfileId, true);
    assert.equal(trimmedProfile.requestedProfileId, 'generate-only');
    assert.equal(trimmedProfile.runtimeProfile.profileId, 'generate-only');
    assert.equal(trimmedProfile.profileContract.profileId, 'generate-only');
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

test('resolveWorkflowRuntimeConfig applies forceWorkflowExecution and review-loop gating', () => {
    const fastRuntimeConfig = resolveWorkflowRuntimeConfig({
        modeId: 'fast',
        reviewLoopEnabled: true,
        maxIterations: 5,
        maxDurationMs: 9000,
    });
    assert.equal(fastRuntimeConfig.profileId, 'generate-only');
    assert.equal(fastRuntimeConfig.workflowExecutionEnabled, false);
    assert.equal(fastRuntimeConfig.workflowExecutionLimits.maxWorkflowSteps, 1);
    assert.equal(
        fastRuntimeConfig.workflowExecutionLimits.maxDeliberationCalls,
        0
    );
    assert.equal(fastRuntimeConfig.workflowExecutionLimits.maxDurationMs, 9000);

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
        executionContractResponseMode: 'fast_direct',
    });
    assert.equal(requested.isKnownRequestedModeId, true);
    assert.equal(requested.modeDecision.modeId, 'balanced');
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
    assert.equal(fallbackDefault.modeDecision.selectedBy, 'fail_open_default');
});

test('resolveWorkflowModeDecision treats non-canonical mode ids as unknown and fails open', () => {
    const legacyFast = resolveWorkflowModeDecision({
        modeId: 'generate-only',
    });
    assert.equal(legacyFast.isKnownRequestedModeId, false);
    assert.equal(legacyFast.modeDecision.modeId, 'grounded');
    assert.equal(legacyFast.modeDecision.selectedBy, 'fail_open_default');
    assert.equal(legacyFast.modeDecision.requestedModeId, 'generate-only');
});

test('deriveReviewIntensityFromWorkflowBehavior centralizes review intensity mapping', () => {
    assert.equal(
        deriveReviewIntensityFromWorkflowBehavior({
            executionContractPresetId: 'fast-direct',
            workflowProfileClass: 'direct',
            workflowProfileId: 'generate-only',
            workflowExecution: 'disabled',
            reviewPass: 'excluded',
            reviseStep: 'disallowed',
            evidencePosture: 'minimal',
            maxWorkflowSteps: 1,
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
            maxDeliberationCalls: 4,
        }),
        'high'
    );
});
