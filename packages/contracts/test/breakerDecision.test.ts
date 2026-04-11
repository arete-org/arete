/**
 * @description: Verifies breaker decision resolution from response metadata
 * stays deterministic and fail-open-safe.
 * @footnote-scope: test
 * @footnote-module: BreakerDecisionResolverTests
 * @footnote-risk: low - Tests only cover metadata parsing behavior.
 * @footnote-ethics: high - Correct parsing is required for adapters to recognize non-allow safety outcomes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveBreakerDecisionContext,
    type ResponseMetadata,
} from '../src/ethics-core';

const createMetadata = (
    overrides: Partial<ResponseMetadata> = {}
): ResponseMetadata => ({
    responseId: 'resp_1',
    provenance: 'Inferred',
    safetyTier: 'Low',
    tradeoffCount: 0,
    chainHash: 'hash_1',
    licenseContext: 'MIT + HL3',
    modelVersion: 'gpt-5-mini',
    staleAfter: new Date(Date.now() + 60_000).toISOString(),
    citations: [],
    ...overrides,
});

test('resolveBreakerDecisionContext prefers metadata.evaluator over execution timeline', () => {
    const metadata = createMetadata({
        evaluator: {
            authorityLevel: 'enforce',
            mode: 'enforced',
            provenance: 'Inferred',
            safetyDecision: {
                action: 'redirect',
                safetyTier: 'High',
                ruleId: 'safety.weaponization_request.v1',
                reasonCode: 'weaponization_request',
                reason: 'Use redirect guardrail text.',
            },
        },
        execution: [
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
                        reason: 'Timeline fallback should not win.',
                    },
                },
            },
        ],
    });

    const resolved = resolveBreakerDecisionContext(metadata);

    assert.equal(resolved?.source, 'metadata.evaluator');
    assert.equal(resolved?.authorityLevel, 'enforce');
    assert.equal(resolved?.mode, 'enforced');
    assert.equal(resolved?.safetyDecision.action, 'redirect');
});

test('resolveBreakerDecisionContext falls back to execution evaluator entries', () => {
    const metadata = createMetadata({
        evaluator: undefined,
        execution: [
            {
                kind: 'planner',
                status: 'executed',
                purpose: 'chat_orchestrator_action_selection',
                contractType: 'text_json',
                applyOutcome: 'applied',
                mattered: false,
                matteredControlIds: [],
            },
            {
                kind: 'evaluator',
                status: 'executed',
                evaluator: {
                    authorityLevel: 'influence',
                    mode: 'observe_only',
                    provenance: 'Inferred',
                    safetyDecision: {
                        action: 'safe_partial',
                        safetyTier: 'Medium',
                        ruleId: 'safety.professional.medical_or_legal_advice.v1',
                        reasonCode: 'professional_advice_guardrail',
                        reason: 'Provide only bounded high-level guidance.',
                    },
                },
            },
        ],
    });

    const resolved = resolveBreakerDecisionContext(metadata);

    assert.equal(resolved?.source, 'metadata.execution');
    assert.equal(resolved?.authorityLevel, 'influence');
    assert.equal(resolved?.mode, 'observe_only');
    assert.equal(resolved?.safetyDecision.action, 'safe_partial');
});

test('resolveBreakerDecisionContext returns null for malformed evaluator payloads', () => {
    const metadata = createMetadata({
        evaluator: {
            authorityLevel: 'enforce',
            mode: 'enforced',
            provenance: 'Inferred',
            safetyDecision: {
                action: 'block',
                safetyTier: 'High',
                ruleId: 'safety.weaponization_request.v1',
                // Missing reason/reasonCode should fail guard and return null.
            },
        } as unknown as ResponseMetadata['evaluator'],
        execution: [],
    });

    assert.equal(resolveBreakerDecisionContext(metadata), null);
});
