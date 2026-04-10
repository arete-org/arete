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

const createBaseControlsInput = (
    overrides: Partial<Parameters<typeof buildSteerabilityControls>[0]> = {}
): Parameters<typeof buildSteerabilityControls>[0] => ({
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
    ...overrides,
});

test('buildSteerabilityControls emits canonical control records for grounded reviewed execution', () => {
    const controls = buildSteerabilityControls(createBaseControlsInput());

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

test('provider_preference records requested_honored state when requested profile is selected', () => {
    const controls = buildSteerabilityControls(createBaseControlsInput());
    const providerPreference = controls.controls.find(
        (control) => control.controlId === 'provider_preference'
    );

    assert.equal(
        providerPreference?.value,
        'state:requested_honored;requested:openai-text-fast;resolved:openai-text-fast(openai/gpt-5-mini)'
    );
    assert.match(providerPreference?.rationale ?? '', /honored/i);
});

test('provider_preference records advisory_overridden state when planner advisory is not selected', () => {
    const controls = buildSteerabilityControls(
        createBaseControlsInput({
            requestedProfileId: undefined,
            plannerSelectedProfileId: 'openai-text-medium',
            selectedProfile: {
                profileId: 'openai-text-fast',
                provider: 'openai',
                model: 'gpt-5-mini',
            },
        })
    );
    const providerPreference = controls.controls.find(
        (control) => control.controlId === 'provider_preference'
    );

    assert.equal(
        providerPreference?.value,
        'state:advisory_overridden;advisory:openai-text-medium;resolved:openai-text-fast(openai/gpt-5-mini)'
    );
    assert.match(providerPreference?.rationale ?? '', /non-authoritative/i);
});

test('provider_preference records fallback_resolved state when no request or advisory exists', () => {
    const controls = buildSteerabilityControls(
        createBaseControlsInput({
            requestedProfileId: undefined,
            plannerSelectedProfileId: undefined,
        })
    );
    const providerPreference = controls.controls.find(
        (control) => control.controlId === 'provider_preference'
    );

    assert.equal(
        providerPreference?.value,
        'state:fallback_resolved;resolved:openai-text-fast(openai/gpt-5-mini)'
    );
});

test('mattered reflects observable causal impact instead of record presence', () => {
    const controls = buildSteerabilityControls(
        createBaseControlsInput({
            workflowMode: {
                modeId: 'fast',
                selectedBy: 'requested_mode',
                selectionReason: 'Configured fast mode selected.',
                behavior: {
                    executionContractPresetId: 'fast-direct',
                    workflowProfileClass: 'direct',
                    workflowProfileId: 'generate-only',
                    workflowExecution: 'disabled',
                    reviewPass: 'excluded',
                    reviseStep: 'disallowed',
                    evidencePosture: 'minimal',
                    maxWorkflowSteps: 1,
                    maxDeliberationCalls: 0,
                },
            },
            persona: {
                personaId: 'footnote',
                overlaySource: 'none',
            },
            toolRequest: {
                toolName: 'web_search',
                requested: false,
                eligible: false,
            },
        })
    );

    assert.equal(
        controls.controls.find(
            (control) => control.controlId === 'review_intensity'
        )?.mattered,
        false
    );
    assert.equal(
        controls.controls.find(
            (control) => control.controlId === 'tool_allowance'
        )?.mattered,
        false
    );
    assert.equal(
        controls.controls.find(
            (control) => control.controlId === 'persona_tone_overlay'
        )?.mattered,
        false
    );
});

test('persona_tone_overlay rationale stays non-authoritative over execution policy', () => {
    const controls = buildSteerabilityControls(
        createBaseControlsInput({
            persona: {
                personaId: 'myuri',
                overlaySource: 'file',
            },
        })
    );
    const personaControl = controls.controls.find(
        (control) => control.controlId === 'persona_tone_overlay'
    );

    assert.match(
        personaControl?.rationale ?? '',
        /did not change execution-contract authority, evidence posture, or review authority/i
    );
});

test('review_intensity derives as light for low-deliberation reviewed behavior', () => {
    const controls = buildSteerabilityControls(
        createBaseControlsInput({
            workflowMode: {
                modeId: 'balanced',
                selectedBy: 'requested_mode',
                selectionReason: 'Configured balanced mode selected.',
                behavior: {
                    executionContractPresetId: 'balanced',
                    workflowProfileClass: 'reviewed',
                    workflowProfileId: 'bounded-review',
                    workflowExecution: 'always',
                    reviewPass: 'included',
                    reviseStep: 'allowed',
                    evidencePosture: 'balanced',
                    maxWorkflowSteps: 4,
                    maxDeliberationCalls: 1,
                },
            },
        })
    );
    const reviewIntensity = controls.controls.find(
        (control) => control.controlId === 'review_intensity'
    );

    assert.equal(reviewIntensity?.value, 'light');
});
