/**
 * @description: Verifies deterministic precedence outcomes for current internal steerability control conflicts.
 * @footnote-scope: test
 * @footnote-module: SteerabilityControlPrecedenceTests
 * @footnote-risk: medium - Missing tests can allow drift where preference or presentation controls look authoritative.
 * @footnote-ethics: high - Authority-boundary regressions can mislead operators about what governed execution behavior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    INTERNAL_STEERABILITY_PRECEDENCE_MATRIX,
    resolveInternalSteerabilityControlConflicts,
} from '../src/services/steerabilityControlPrecedence.js';

test('precedence matrix keeps execution_policy above preference and presentation controls', () => {
    const executionOverPreference =
        INTERNAL_STEERABILITY_PRECEDENCE_MATRIX.find(
            (rule) =>
                rule.higherAuthority === 'execution_policy' &&
                rule.lowerAuthority === 'preference_signal'
        );
    const executionOverPresentation =
        INTERNAL_STEERABILITY_PRECEDENCE_MATRIX.find(
            (rule) =>
                rule.higherAuthority === 'execution_policy' &&
                rule.lowerAuthority === 'presentation_only'
        );

    assert.ok(executionOverPreference);
    assert.equal(executionOverPreference?.outcome, 'higher_wins');
    assert.ok(executionOverPresentation);
    assert.equal(executionOverPresentation?.outcome, 'higher_wins');
});

test('requested provider preference cannot override execution-policy-selected profile', () => {
    const resolved = resolveInternalSteerabilityControlConflicts({
        requestedProfileId: 'openai-text-quality',
        plannerSelectedProfileId: 'openai-text-quality',
        selectedProfileId: 'openai-text-fast',
        personaOverlaySource: 'none',
    });

    assert.equal(resolved.providerPreference.state, 'requested_overridden');
    assert.equal(
        resolved.providerPreference.wasOverriddenByExecutionPolicy,
        true
    );
    assert.equal(
        resolved.providerPreference.canEscalateIntoExecutionPolicyAuthority,
        false
    );
});

test('planner advisory provider preference emits advisory_overridden when runtime policy selects different profile', () => {
    const resolved = resolveInternalSteerabilityControlConflicts({
        requestedProfileId: undefined,
        plannerSelectedProfileId: 'openai-text-quality',
        selectedProfileId: 'openai-text-fast',
        personaOverlaySource: 'none',
    });

    assert.equal(resolved.providerPreference.source, 'planner_output');
    assert.equal(resolved.providerPreference.state, 'advisory_overridden');
    assert.equal(
        resolved.providerPreference.wasOverriddenByExecutionPolicy,
        true
    );
});

test('persona tone overlay remains presentation-only and non-authoritative', () => {
    const resolved = resolveInternalSteerabilityControlConflicts({
        selectedProfileId: 'openai-text-fast',
        personaOverlaySource: 'file',
    });

    assert.equal(resolved.personaToneOverlay.state, 'presentation_applied');
    assert.equal(resolved.personaToneOverlay.overlayApplied, true);
    assert.equal(
        resolved.personaToneOverlay.canEscalateIntoExecutionPolicyAuthority,
        false
    );
});
