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

test('web search provider selection uses enabled-order fallback when ordered branch has no overlap', () => {
    const plan = resolveWebSearchProviderSelectionPlan({
        policy: {
            mode: 'preferred_order',
            enabledProviders: ['searxng', 'openai', 'brave'],
            providerOrder: [],
        },
        availableProviders: ['openai', 'searxng'],
    });

    assert.equal(plan.mode, 'preferred_order');
    assert.deepEqual(plan.candidates, ['searxng', 'openai']);
});

test('web search provider selection preserves auto mode and ordered candidate behavior', () => {
    const plan = resolveWebSearchProviderSelectionPlan({
        policy: {
            mode: 'auto',
            enabledProviders: ['openai', 'searxng', 'brave'],
            providerOrder: ['brave', 'openai', 'searxng'],
        },
        availableProviders: ['openai', 'searxng'],
    });

    assert.equal(plan.mode, 'auto');
    assert.deepEqual(plan.candidates, ['openai', 'searxng']);
});
