/**
 * @description: Verifies assess-hint extraction and revision candidate reordering behavior.
 * @footnote-scope: test
 * @footnote-module: WorkflowEngineRevisionRoutingHintsTests
 * @footnote-risk: low - Test-only coverage for revision routing hint helpers.
 * @footnote-ethics: medium - Hint precedence tests protect transparent routing behavior.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelProfile } from '@footnote/contracts';
import type { ResolvedStepRoutingCandidate } from '../../src/services/stepRoutingChains.js';
import {
    decideRevisionRoutingHintLane,
    extractRoutingHintsFromAssess,
    reorderRevisionCandidatesByHintLane,
} from '../../src/services/workflowEngine/revisionRoutingHints.js';

const openAiProfile: ModelProfile = {
    id: 'openai-text-medium',
    description: 'OpenAI medium profile',
    provider: 'openai',
    providerModel: 'gpt-5.4-mini',
    enabled: true,
    tierBindings: ['text-medium'],
    capabilities: { canUseSearch: true },
    costClass: 'medium',
};

const ollamaLowProfile: ModelProfile = {
    id: 'ollama-text-gptoss',
    description: 'Ollama low-cost profile',
    provider: 'ollama',
    providerModel: 'gpt-oss:20b-cloud',
    enabled: true,
    tierBindings: ['text-medium'],
    capabilities: { canUseSearch: false },
    costClass: 'low',
};

const ollamaHighProfile: ModelProfile = {
    id: 'ollama-text-qwen',
    description: 'Ollama high-cost profile',
    provider: 'ollama',
    providerModel: 'qwen3.5:cloud',
    enabled: true,
    tierBindings: ['text-quality'],
    capabilities: { canUseSearch: false },
    costClass: 'high',
};

const enabledProfilesById = new Map<string, ModelProfile>([
    [openAiProfile.id, openAiProfile],
    [ollamaLowProfile.id, ollamaLowProfile],
    [ollamaHighProfile.id, ollamaHighProfile],
]);

const baseCandidates: ResolvedStepRoutingCandidate[] = [
    { profileId: openAiProfile.id, chooseOneUsed: false },
    { profileId: ollamaHighProfile.id, chooseOneUsed: true },
    { profileId: ollamaLowProfile.id, chooseOneUsed: true },
];

test('extractRoutingHintsFromAssess detects style and logic hints from freeform text', () => {
    const hints = extractRoutingHintsFromAssess({
        assessRawText:
            'reviewReason: too stiff and robotic; revisionInstruction: more precise logic and citation strict',
        reviewDecision: {
            reviewDecision: 'revise',
            reviewReason: 'Need less AI speak',
            revisionInstruction:
                'Use style.ai_speak_down and logic.precision_up',
        },
    });

    assert.equal(hints.includes('style.ai_speak_down'), true);
    assert.equal(hints.includes('logic.precision_up'), true);
    assert.equal(hints.includes('grounding.citation_strict'), true);
});

test('decideRevisionRoutingHintLane resolves style+logic conflict to logic-first', () => {
    const decision = decideRevisionRoutingHintLane([
        'style.creativity_up',
        'logic.precision_up',
    ]);
    assert.equal(decision.lane, 'openai_first_logic');
    assert.equal(decision.conflictResolved, 'logic_over_style');
});

test('reorderRevisionCandidatesByHintLane prioritizes ollama for style lane', () => {
    const reordered = reorderRevisionCandidatesByHintLane({
        candidates: baseCandidates,
        enabledProfilesById,
        lane: 'ollama_first_style',
    });
    assert.equal(reordered[0]?.profileId, ollamaHighProfile.id);
});

test('reorderRevisionCandidatesByHintLane prioritizes openai for logic lane', () => {
    const reordered = reorderRevisionCandidatesByHintLane({
        candidates: baseCandidates,
        enabledProfilesById,
        lane: 'openai_first_logic',
    });
    assert.equal(reordered[0]?.profileId, openAiProfile.id);
});

test('reorderRevisionCandidatesByHintLane prioritizes cheaper candidates for cheaper lane', () => {
    const reordered = reorderRevisionCandidatesByHintLane({
        candidates: baseCandidates,
        enabledProfilesById,
        lane: 'cheaper_first',
    });
    assert.equal(reordered[0]?.profileId, ollamaLowProfile.id);
});
