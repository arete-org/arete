/**
 * @description: Validates capability-profile policy mapping and capability-floor enforcement for workflow model selection.
 * @footnote-scope: test
 * @footnote-module: ModelCapabilityPolicyTests
 * @footnote-risk: medium - Missing tests here can hide resolver-policy drift that silently changes model routing.
 * @footnote-ethics: medium - Capability-floor regressions can reduce grounding quality without obvious failures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ModelProfile } from '@footnote/contracts';
import {
    listCapabilityProfileOptionsForStep,
    normalizeRequestedCapabilityProfile,
    selectModelProfileForWorkflowStep,
} from '../src/services/modelCapabilityPolicy.js';

const buildProfile = (
    overrides: Partial<ModelProfile> &
        Pick<ModelProfile, 'id' | 'providerModel'>
): ModelProfile => ({
    id: overrides.id,
    description: overrides.description ?? overrides.id,
    provider: overrides.provider ?? 'openai',
    providerModel: overrides.providerModel,
    enabled: overrides.enabled ?? true,
    tierBindings: overrides.tierBindings ?? [],
    capabilities: overrides.capabilities ?? { canUseSearch: false },
    costClass: overrides.costClass,
    latencyClass: overrides.latencyClass,
});

test('listCapabilityProfileOptionsForStep exposes bounded generation capability profiles', () => {
    const options = listCapabilityProfileOptionsForStep('generation');
    assert.deepEqual(
        options.map((option) => option.id),
        ['structured-cheap', 'balanced-general', 'expressive-generation']
    );
    assert.equal(
        options.every((option) => option.description.length > 0),
        true
    );
});

test('normalizeRequestedCapabilityProfile accepts valid step-allowed capability ids', () => {
    assert.equal(
        normalizeRequestedCapabilityProfile('generation', 'structured-cheap'),
        'structured-cheap'
    );
    assert.equal(
        normalizeRequestedCapabilityProfile('generation', 'strict-review'),
        undefined
    );
    assert.equal(
        normalizeRequestedCapabilityProfile('generation', 'missing-capability'),
        undefined
    );
});

test('selectModelProfileForWorkflowStep enforces search capability floor before compatibility ranking', () => {
    const selection = selectModelProfileForWorkflowStep({
        step: 'generation',
        requestedCapabilityProfile: 'structured-cheap',
        profiles: [
            buildProfile({
                id: 'openai-text-fast',
                providerModel: 'gpt-5-mini',
                tierBindings: ['text-fast'],
                capabilities: { canUseSearch: false },
                costClass: 'low',
                latencyClass: 'low',
            }),
        ],
        requiresSearch: true,
    });

    assert.equal(selection.selectedProfile, undefined);
    assert.equal(
        selection.reasonCode,
        'planner_requested_capability_profile_no_floor_match'
    );
});

test('selectModelProfileForWorkflowStep chooses compatible candidate and reports invalid requested capability', () => {
    const selection = selectModelProfileForWorkflowStep({
        step: 'generation',
        requestedCapabilityProfile: 'not-real',
        profiles: [
            buildProfile({
                id: 'openai-text-quality',
                providerModel: 'gpt-5',
                tierBindings: ['text-quality'],
                capabilities: { canUseSearch: true },
                costClass: 'high',
                latencyClass: 'medium',
            }),
            buildProfile({
                id: 'openai-text-medium',
                providerModel: 'gpt-5-mini',
                tierBindings: ['text-medium'],
                capabilities: { canUseSearch: true },
                costClass: 'medium',
                latencyClass: 'medium',
            }),
        ],
        requiresSearch: false,
    });

    assert.equal(selection.selectedCapabilityProfile, 'balanced-general');
    assert.equal(selection.selectedProfile?.id, 'openai-text-medium');
    assert.equal(
        selection.reasonCode,
        'planner_requested_capability_profile_invalid'
    );
});
