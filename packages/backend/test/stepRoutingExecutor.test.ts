/**
 * @description: Validates model-chain attempt execution and strict transient fallback progression.
 * @footnote-scope: test
 * @footnote-module: StepRoutingExecutorTests
 * @footnote-risk: low - Test-only coverage for chain executor behavior.
 * @footnote-ethics: medium - Fallback telemetry and deterministic fail-open behavior need explicit checks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelProfile } from '@footnote/contracts';
import { executeStepRoutingChain } from '../src/services/stepRoutingExecutor.js';

const makeProfile = (input: {
    id: string;
    provider: 'openai' | 'ollama';
    providerModel: string;
    canUseSearch: boolean;
}): ModelProfile => ({
    id: input.id,
    description: input.id,
    provider: input.provider,
    providerModel: input.providerModel,
    enabled: true,
    tierBindings: [],
    capabilities: { canUseSearch: input.canUseSearch },
});

test('executeStepRoutingChain advances on transient errors and succeeds on next candidate', async () => {
    const first = makeProfile({
        id: 'openai-text-medium',
        provider: 'openai',
        providerModel: 'gpt-5.4-mini',
        canUseSearch: true,
    });
    const second = makeProfile({
        id: 'ollama-text-gptoss',
        provider: 'ollama',
        providerModel: 'gpt-oss:20b-cloud',
        canUseSearch: true,
    });
    const enabledProfilesById = new Map([
        [first.id, first],
        [second.id, second],
    ]);

    let calls = 0;
    const result = await executeStepRoutingChain({
        step: 'generate',
        candidates: [
            { profileId: first.id, chooseOneUsed: false },
            { profileId: second.id, chooseOneUsed: false },
        ],
        enabledProfilesById,
        requiresSearch: false,
        runWithProfile: async (profile) => {
            calls += 1;
            if (profile.id === first.id) {
                throw new Error('429 rate limit');
            }
            return profile.id;
        },
    });

    assert.equal(calls, 2);
    assert.equal(result.status, 'executed');
    if (result.status === 'executed') {
        assert.equal(result.selected.profile.id, second.id);
        assert.equal(result.attempts.length, 2);
        assert.equal(result.attempts[0]?.status, 'failed_transient_advanced');
        assert.equal(result.attempts[1]?.status, 'executed');
    }
});

test('executeStepRoutingChain stops on non-transient errors', async () => {
    const first = makeProfile({
        id: 'openai-text-medium',
        provider: 'openai',
        providerModel: 'gpt-5.4-mini',
        canUseSearch: true,
    });
    const second = makeProfile({
        id: 'ollama-text-gptoss',
        provider: 'ollama',
        providerModel: 'gpt-oss:20b-cloud',
        canUseSearch: true,
    });
    const enabledProfilesById = new Map([
        [first.id, first],
        [second.id, second],
    ]);

    let calls = 0;
    const result = await executeStepRoutingChain({
        step: 'assess',
        candidates: [
            { profileId: first.id, chooseOneUsed: false },
            { profileId: second.id, chooseOneUsed: false },
        ],
        enabledProfilesById,
        requiresSearch: false,
        runWithProfile: async () => {
            calls += 1;
            throw new Error('401 unauthorized');
        },
    });

    assert.equal(calls, 1);
    assert.equal(result.status, 'exhausted');
    if (result.status === 'exhausted') {
        assert.equal(result.reasonCode, 'routing_chain_non_transient_error');
        assert.equal(result.attempts.length, 1);
        assert.equal(
            result.attempts[0]?.status,
            'failed_non_transient_stopped'
        );
    }
});
