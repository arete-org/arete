/**
 * @description: Verifies the shared control observability envelope keeps required
 * input, decision, and outcome fields explicit and auditable.
 * @footnote-scope: test
 * @footnote-module: SteerabilityControlObservabilityTests
 * @footnote-risk: medium - Missing checks here can allow silent drift in control observability payloads.
 * @footnote-ethics: high - Incomplete control lineage can mislead operators about runtime decisions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildControlObservabilityEnvelope,
    listMissingControlObservabilityFields,
} from '../src/services/steerabilityControlObservability.js';
import { buildSteerabilityControls } from '../src/services/steerabilityControls.js';

const createEnvelopeInput = (): Parameters<
    typeof buildControlObservabilityEnvelope
>[0] => {
    const steerabilityControls = buildSteerabilityControls({
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
        plannerSelectedProfileId: 'openai-text-fast',
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
            eligible: true,
        },
    });

    return {
        surface: 'discord',
        workflowModeId: 'grounded',
        executionContractResponseMode: 'quality_grounded',
        requestedProfileId: 'openai-text-fast',
        plannerSelectedProfileId: 'openai-text-fast',
        selectedProfileId: 'openai-text-fast',
        personaOverlaySource: 'file',
        toolRequest: {
            toolName: 'web_search',
            requested: true,
            eligible: true,
        },
        plannerApplyOutcome: 'applied',
        plannerMatteredControlIds: ['tool_allowance'],
        plannerStatus: 'executed',
        plannerReasonCode: undefined,
        responseAction: 'message',
        responseModality: 'text',
        steerabilityControls,
    };
};

test('buildControlObservabilityEnvelope emits required input/decision/outcome groups', () => {
    const envelope = buildControlObservabilityEnvelope(createEnvelopeInput());

    assert.equal(envelope.version, 'v1');
    assert.equal(envelope.input.surface, 'discord');
    assert.equal(envelope.decision.plannerApplyOutcome, 'applied');
    assert.equal(envelope.outcome.responseAction, 'message');
    assert.equal(envelope.outcome.mattered, true);
    assert.equal(listMissingControlObservabilityFields(envelope).length, 0);
});

test('buildControlObservabilityEnvelope throws when required fields are missing', () => {
    const input = createEnvelopeInput();
    const trimmedInput = {
        ...input,
        selectedProfileId: '   ',
    };

    assert.throws(
        () => buildControlObservabilityEnvelope(trimmedInput),
        /missing required fields/i
    );
});
