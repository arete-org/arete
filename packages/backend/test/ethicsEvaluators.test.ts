/**
 * @description: Verifies deterministic provenance and risk evaluator behavior.
 * @footnote-scope: test
 * @footnote-module: EthicsEvaluatorsTests
 * @footnote-risk: medium - Missing tests could hide incorrect provenance/risk routing and regressions.
 * @footnote-ethics: high - Misclassification can reduce safety handling quality and transparency trust.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    computeProvenance,
    computeProvenanceSignals,
    computeRiskTier,
    evaluateRiskTierDeterministic,
} from '../src/ethics-core/evaluators.js';

test('computeProvenance returns Retrieved when retrieval signals exist', () => {
    const provenance = computeProvenance([
        'web_search_call executed for current events',
        'Source: https://example.com/article',
    ]);

    assert.equal(provenance, 'Retrieved');
});

test('computeProvenance returns Speculative when speculation signals exist without retrieval signals', () => {
    const provenance = computeProvenance([
        'I might be wrong, but this appears to be true.',
    ]);

    assert.equal(provenance, 'Speculative');
});

test('computeProvenance keeps Retrieved precedence when retrieval and speculation signals both exist', () => {
    const provenance = computeProvenance([
        'According to https://example.com, this might change tomorrow.',
    ]);

    assert.equal(provenance, 'Retrieved');
});

test('computeProvenance returns Inferred for grounded context with no retrieval or speculation markers', () => {
    const provenance = computeProvenance([
        'The answer summarizes known system constraints and tradeoffs.',
    ]);

    assert.equal(provenance, 'Inferred');
});

test('computeProvenance stays fail-open and deterministic for empty context', () => {
    const provenance = computeProvenance([]);

    assert.equal(provenance, 'Speculative');
});

test('computeProvenanceSignals returns a serializable signal map', () => {
    const signals = computeProvenanceSignals([
        'Citation: [1](https://example.com)',
        'This might be stale.',
    ]);

    assert.deepEqual(signals, {
        retrieval: true,
        speculation: true,
        hasContext: true,
    });
    assert.equal(typeof JSON.stringify(signals), 'string');
});

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
