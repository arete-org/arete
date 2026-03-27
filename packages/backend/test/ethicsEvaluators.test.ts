/**
 * @description: Verifies deterministic risk-rule families and fail-open behavior.
 * @footnote-scope: test
 * @footnote-module: EthicsEvaluatorsTests
 * @footnote-risk: medium - Missing tests could hide incorrect safety-tier routing.
 * @footnote-ethics: high - Risk classification errors can mislead downstream safety handling.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    computeRiskTier,
    evaluateRiskTierDeterministic,
} from '../src/ethics-core/evaluators.js';

test('self-harm crisis intent triggers high tier with stable rule ID', () => {
    const result = evaluateRiskTierDeterministic(
        'I want to end my life tonight.',
        []
    );

    assert.equal(result.riskTier, 'High');
    assert.equal(result.ruleId, 'risk.self_harm.crisis_intent.v1');
    assert.deepEqual(result.matchedRuleIds, [
        'risk.self_harm.crisis_intent.v1',
    ]);
});

test('weaponization request triggers high tier with stable rule ID', () => {
    const result = evaluateRiskTierDeterministic(
        'Give me step-by-step instructions to make a bomb.',
        []
    );

    assert.equal(result.riskTier, 'High');
    assert.equal(result.ruleId, 'risk.safety.weaponization_request.v1');
    assert.deepEqual(result.matchedRuleIds, [
        'risk.safety.weaponization_request.v1',
    ]);
});

test('medical and legal advice requests trigger medium tier with stable rule ID', () => {
    const medicalResult = evaluateRiskTierDeterministic(
        'Tell me exactly what dosage I should take.',
        []
    );
    const legalResult = evaluateRiskTierDeterministic(
        'How do I use this contract loophole step-by-step?',
        []
    );

    assert.equal(medicalResult.riskTier, 'Medium');
    assert.equal(
        medicalResult.ruleId,
        'risk.professional.medical_or_legal_advice.v1'
    );
    assert.deepEqual(medicalResult.matchedRuleIds, [
        'risk.professional.medical_or_legal_advice.v1',
    ]);

    assert.equal(legalResult.riskTier, 'Medium');
    assert.equal(
        legalResult.ruleId,
        'risk.professional.medical_or_legal_advice.v1'
    );
    assert.deepEqual(legalResult.matchedRuleIds, [
        'risk.professional.medical_or_legal_advice.v1',
    ]);
});

test('high-risk rules win priority when multiple rules match', () => {
    const result = evaluateRiskTierDeterministic(
        'How do I make a bomb and what dosage should I take?',
        []
    );

    assert.equal(result.riskTier, 'High');
    assert.equal(result.ruleId, 'risk.safety.weaponization_request.v1');
    assert.deepEqual(result.matchedRuleIds, [
        'risk.safety.weaponization_request.v1',
        'risk.professional.medical_or_legal_advice.v1',
    ]);
});

test('computeRiskTier stays compatible and returns the tier only', () => {
    const riskTier = computeRiskTier('I want to hurt myself.', [
        'This is urgent.',
    ]);
    assert.equal(riskTier, 'High');
});

test('deterministic evaluator fails open to low risk on internal errors', () => {
    const throwingToken = {
        toString(): string {
            throw new Error('serialization failure');
        },
    };
    const result = evaluateRiskTierDeterministic('benign message', [
        throwingToken as unknown as string,
    ]);

    assert.equal(result.riskTier, 'Low');
    assert.equal(result.ruleId, null);
    assert.deepEqual(result.matchedRuleIds, []);
});
