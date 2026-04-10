/**
 * @description: Verifies Execution Policy Contract resolver assembly invariants for preset mapping and sanitization.
 * @footnote-scope: test
 * @footnote-module: ExecutionPolicyResolverTests
 * @footnote-risk: medium - Missing resolver tests can allow EPC preset drift across runtime seams.
 * @footnote-ethics: high - EPC policy drift can silently change authority and fail-open behavior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveExecutionPolicyContract } from '../src/services/executionPolicyResolver.js';

test('resolveExecutionPolicyContract maps known preset ids deterministically', () => {
    const qualityGrounded = resolveExecutionPolicyContract({
        presetId: '  quality-grounded  ',
    });

    assert.equal(qualityGrounded.requestedPresetId, 'quality-grounded');
    assert.equal(qualityGrounded.isKnownPresetId, true);
    assert.equal(
        qualityGrounded.policyContract.policyId,
        'core-quality-grounded'
    );
    assert.equal(qualityGrounded.policyContract.policyVersion, 'v1');
    assert.equal(
        qualityGrounded.policyContract.response.responseMode,
        'quality_grounded'
    );
    assert.equal(
        qualityGrounded.policyContract.response.stoppingRule,
        'bounded_sufficient_answer'
    );
});

test('resolveExecutionPolicyContract fails open to fast-direct descriptor for unknown preset ids', () => {
    const unknownPreset = resolveExecutionPolicyContract({
        presetId: 'nonexistent-preset',
    });

    assert.equal(unknownPreset.requestedPresetId, 'nonexistent-preset');
    assert.equal(unknownPreset.isKnownPresetId, false);
    assert.equal(unknownPreset.policyContract.policyId, 'core-fast-direct');
    assert.equal(unknownPreset.policyContract.displayName, 'Core Fast Direct');
    assert.equal(
        unknownPreset.policyContract.response.responseMode,
        'fast_direct'
    );
});

test('resolveExecutionPolicyContract sanitizes unsafe numeric overrides and keeps hard invariants', () => {
    const capabilityTags = ['custom_tag'];
    const resolved = resolveExecutionPolicyContract({
        presetId: 'quality-grounded',
        policyId: 'test-policy-id',
        displayName: 'Test Policy Display Name',
        overrides: {
            evidence: {
                maxEscalationRounds: Number.NaN,
            },
            limits: {
                maxWorkflowSteps: -1,
                maxToolCalls: Number.POSITIVE_INFINITY,
                maxDeliberationCalls: -7,
                maxTokensTotal: Number.NaN,
                maxDurationMs: -500,
            },
            failOpen: {
                allowFallbackGeneration: false,
            },
            routing: {
                capabilityTags,
            },
            trustGraph: {
                evidenceMode: 'off',
            },
        },
    });

    assert.equal(resolved.policyContract.policyId, 'test-policy-id');
    assert.equal(
        resolved.policyContract.displayName,
        'Test Policy Display Name'
    );
    assert.equal(resolved.policyContract.evidence.maxEscalationRounds, 1);
    assert.equal(resolved.policyContract.limits.maxWorkflowSteps, 4);
    assert.equal(resolved.policyContract.limits.maxToolCalls, 1);
    assert.equal(resolved.policyContract.limits.maxDeliberationCalls, 1);
    assert.equal(resolved.policyContract.limits.maxTokensTotal, 8000);
    assert.equal(resolved.policyContract.limits.maxDurationMs, 25000);
    assert.equal(resolved.policyContract.failOpen.authority, 'backend');
    assert.equal(
        resolved.policyContract.failOpen.fallbackTemperature,
        'deterministic'
    );
    assert.equal(
        resolved.policyContract.failOpen.allowFallbackGeneration,
        false
    );
    assert.equal(resolved.policyContract.trustGraph.canBlockExecution, false);
    assert.deepEqual(resolved.policyContract.routing.capabilityTags, [
        'custom_tag',
    ]);

    resolved.policyContract.routing.capabilityTags.push('mutated');
    assert.deepEqual(capabilityTags, ['custom_tag']);
});
