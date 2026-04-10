/**
 * @description: Verifies steerability control normalization maps orchestration decisions to inspectable control records.
 * @footnote-scope: test
 * @footnote-module: SteerabilityControlsTests
 * @footnote-risk: medium - Regressions here can hide which controls affected execution.
 * @footnote-ethics: high - Incorrect control provenance weakens auditability of response behavior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSteerabilityControls } from '../src/services/steerabilityControls.js';

test('buildSteerabilityControls emits canonical control records for grounded reviewed execution', () => {
    const controls = buildSteerabilityControls({
        workflowMode: {
            modeId: 'grounded',
            selectedBy: 'requested_mode',
            selectionReason: 'Configured mode selected.',
            behavior: {
                executionContractPresetId: 'quality-grounded',
                workflowProfileClass: 'reviewed',
                workflowProfileId: 'bounded-review',
                workflowExecution: 'policy_gated',
                reviewPass: 'included',
                reviseStep: 'allowed',
                evidencePosture: 'strict',
                maxWorkflowSteps: 8,
                maxDeliberationCalls: 4,
            },
        },
        executionContractResponseMode: 'quality_grounded',
        requestedProfileId: 'openai-text-fast',
        plannerSelectedProfileId: 'openai-text-medium',
        selectedProfile: {
            profileId: 'openai-text-fast',
            provider: 'openai',
            model: 'gpt-5-mini',
        },
        persona: {
            personaId: 'myuri',
            overlaySource: 'file',
        },
        toolRequest: {
            toolName: 'web_search',
            requested: true,
            eligible: false,
            reasonCode: 'search_not_supported_by_selected_profile',
        },
    });

    assert.equal(controls.version, 'v1');
    assert.equal(controls.controls.length, 6);
    assert.equal(
        controls.controls.find(
            (control) => control.controlId === 'workflow_mode'
        )?.value,
        'grounded'
    );
    assert.equal(
        controls.controls.find(
            (control) => control.controlId === 'evidence_strictness'
        )?.value,
        'strict'
    );
    assert.equal(
        controls.controls.find(
            (control) => control.controlId === 'review_intensity'
        )?.value,
        'high'
    );
    assert.equal(
        controls.controls.find(
            (control) => control.controlId === 'tool_allowance'
        )?.value,
        'blocked:web_search:search_not_supported_by_selected_profile'
    );
});
