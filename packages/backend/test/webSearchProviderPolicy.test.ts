/**
 * @description: Verifies provider-policy candidate selection for web search context integration scaffolding.
 * @footnote-scope: test
 * @footnote-module: WebSearchProviderPolicyTests
 * @footnote-risk: low - Tests cover deterministic ordering and availability filtering only.
 * @footnote-ethics: low - Selection planning tests do not execute external providers or user-affecting policy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWebSearchProviderSelectionPlan } from '../src/services/contextIntegrations/webSearch/index.js';

test('web search provider selection honors ordered enabled providers', () => {
    const plan = resolveWebSearchProviderSelectionPlan({
        policy: {
            mode: 'preferred_order',
            enabledProviders: ['openai', 'brave', 'searxng'],
            providerOrder: ['brave', 'searxng', 'openai'],
        },
        availableProviders: ['openai', 'searxng'],
    });

    assert.equal(plan.mode, 'preferred_order');
    assert.deepEqual(plan.candidates, ['searxng', 'openai']);
});

test('web search provider selection returns empty candidates when no enabled providers are available', () => {
    const plan = resolveWebSearchProviderSelectionPlan({
        policy: {
            mode: 'strict',
            enabledProviders: ['brave'],
            providerOrder: ['brave'],
        },
        availableProviders: ['openai'],
    });

    assert.equal(plan.mode, 'strict');
    assert.deepEqual(plan.candidates, []);
});
