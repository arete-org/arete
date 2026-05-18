/**
 * @description: Verifies deterministic per-step profile chain resolution and random pool behavior.
 * @footnote-scope: test
 * @footnote-module: StepRoutingChainsTests
 * @footnote-risk: low - Test-only coverage for routing helper behavior.
 * @footnote-ethics: medium - Deterministic routing tests support transparent, reproducible model selection.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelProfile } from '@footnote/contracts';
import { resolveStepRoutingChain } from '../src/services/stepRoutingChains.js';

const profiles: ModelProfile[] = [
    {
        id: 'openai-text-fast',
        description: 'Fast profile',
        provider: 'openai',
        providerModel: 'gpt-5-mini',
        enabled: true,
        tierBindings: ['text-fast'],
        capabilities: { canUseSearch: true },
    },
    {
        id: 'openai-text-medium',
        description: 'Medium profile',
        provider: 'openai',
        providerModel: 'gpt-5.4-mini',
        enabled: true,
        tierBindings: ['text-medium'],
        capabilities: { canUseSearch: true },
    },
    {
        id: 'openai-json-optimized',
        description: 'JSON optimized profile',
        provider: 'openai',
        providerModel: 'gpt-5.4-nano',
        enabled: true,
        tierBindings: [],
        capabilities: { canUseSearch: true },
    },
    {
        id: 'ollama-text-gptoss',
        description: 'Ollama fallback',
        provider: 'ollama',
        providerModel: 'gpt-oss:20b-cloud',
        enabled: true,
        tierBindings: ['text-medium'],
        capabilities: { canUseSearch: false },
    },
    {
        id: 'ollama-text-qwen',
        description: 'Ollama qwen',
        provider: 'ollama',
        providerModel: 'qwen3.5:cloud',
        enabled: true,
        tierBindings: ['text-quality'],
        capabilities: { canUseSearch: false },
    },
    {
        id: 'ollama-ministral-3-14b',
        description: 'Ollama ministral',
        provider: 'ollama',
        providerModel: 'ministral-3:14b',
        enabled: true,
        tierBindings: [],
        capabilities: { canUseSearch: false },
    },
    {
        id: 'ollama-rnj-1-8b',
        description: 'Ollama rnj',
        provider: 'ollama',
        providerModel: 'rnj-1:8b',
        enabled: true,
        tierBindings: [],
        capabilities: { canUseSearch: false },
    },
    {
        id: 'ollama-nemotron-3-nano-30b',
        description: 'Ollama nemotron nano',
        provider: 'ollama',
        providerModel: 'nemotron-3-nano:30b',
        enabled: true,
        tierBindings: [],
        capabilities: { canUseSearch: false },
    },
];

const enabledProfilesById = new Map(
    profiles.map((profile) => [profile.id, profile])
);
const allProfilesById = new Map(
    profiles.map((profile) => [profile.id, profile])
);

test('resolveStepRoutingChain is stable for same session/step input', () => {
    const request = {
        sessionId: 'session-1',
        traceTarget: undefined,
    };
    const first = resolveStepRoutingChain(
        {
            modeId: 'grounded',
            step: 'planner',
            request,
            correlationId: 'corr-1',
        },
        enabledProfilesById,
        allProfilesById
    );
    const second = resolveStepRoutingChain(
        {
            modeId: 'grounded',
            step: 'planner',
            request,
            correlationId: 'corr-1',
        },
        enabledProfilesById,
        allProfilesById
    );

    assert.deepEqual(first, second);
});

test('resolveStepRoutingChain supports advisory step overrides', () => {
    const resolved = resolveStepRoutingChain(
        {
            modeId: 'balanced',
            step: 'generate',
            request: {
                sessionId: undefined,
                traceTarget: undefined,
            },
            correlationId: 'corr-2',
            stepOverrideProfileId: 'openai-text-medium',
        },
        enabledProfilesById,
        allProfilesById
    );

    assert.equal(resolved[0]?.profileId, 'openai-text-medium');
});

test('resolveStepRoutingChain uses deterministic chooseOne selection with seed variation', () => {
    const first = resolveStepRoutingChain(
        {
            modeId: 'grounded',
            step: 'generate',
            request: {
                sessionId: 'session-a',
                traceTarget: undefined,
            },
            correlationId: 'corr-a',
        },
        enabledProfilesById,
        allProfilesById
    );
    const secondSameSeed = resolveStepRoutingChain(
        {
            modeId: 'grounded',
            step: 'generate',
            request: {
                sessionId: 'session-a',
                traceTarget: undefined,
            },
            correlationId: 'corr-a',
        },
        enabledProfilesById,
        allProfilesById
    );
    let observedDifferentSeedPick = false;
    for (let index = 0; index < 20; index += 1) {
        const differentSeedResult = resolveStepRoutingChain(
            {
                modeId: 'grounded',
                step: 'generate',
                request: {
                    sessionId: `session-b-${index}`,
                    traceTarget: undefined,
                },
                correlationId: `corr-b-${index}`,
            },
            enabledProfilesById,
            allProfilesById
        );
        if (first[1]?.profileId !== differentSeedResult[1]?.profileId) {
            observedDifferentSeedPick = true;
            break;
        }
    }

    assert.deepEqual(first, secondSameSeed);
    assert.equal(first[0]?.profileId !== undefined, true);
    assert.equal(observedDifferentSeedPick, true);
});

test('resolveStepRoutingChain spreads chooseOne picks across seeds', () => {
    const selections = new Set<string>();
    for (let index = 0; index < 25; index += 1) {
        const resolved = resolveStepRoutingChain(
            {
                modeId: 'grounded',
                step: 'generate',
                request: {
                    sessionId: `session-${index}`,
                    traceTarget: undefined,
                },
                correlationId: `corr-${index}`,
            },
            enabledProfilesById,
            allProfilesById
        );
        if (resolved[1]?.profileId) {
            selections.add(resolved[1].profileId);
        }
    }
    assert.equal(selections.size >= 2, true);
});

test('default step routing keeps balanced ollama-first and grounded openai-first generation bias', () => {
    const balanced = resolveStepRoutingChain(
        {
            modeId: 'balanced',
            step: 'generate',
            request: {
                sessionId: 'session-balanced',
                traceTarget: undefined,
            },
            correlationId: 'corr-balanced',
        },
        enabledProfilesById,
        allProfilesById
    );
    const grounded = resolveStepRoutingChain(
        {
            modeId: 'grounded',
            step: 'generate',
            request: {
                sessionId: 'session-grounded',
                traceTarget: undefined,
            },
            correlationId: 'corr-grounded',
        },
        enabledProfilesById,
        allProfilesById
    );

    assert.equal(balanced[0]?.profileId?.startsWith('ollama-') ?? false, true);
    assert.equal(grounded[0]?.profileId?.startsWith('openai-') ?? false, true);
});
