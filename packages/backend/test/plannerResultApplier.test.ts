/**
 * @description: Verifies planner-result policy application seam behavior.
 * @footnote-scope: test
 * @footnote-module: PlannerResultApplierTests
 * @footnote-risk: medium - Regressions here can misapply planner suggestions and alter routing.
 * @footnote-ethics: high - This seam enforces planner-advisory boundaries under backend policy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PostChatRequest } from '@footnote/contracts/web';
import { runtimeConfig } from '../src/config.js';
import { resolveExecutionContract } from '../src/services/executionContractResolver.js';
import { createPlannerResultApplier } from '../src/services/chatOrchestrator/plannerResultApplier.js';
import type { PlannerStepResult } from '../src/services/plannerWorkflowSeams.js';

const createChatRequest = (
    overrides: Partial<PostChatRequest> = {}
): PostChatRequest => ({
    surface: 'discord',
    trigger: { kind: 'direct' },
    latestUserInput: 'Weather in Paris please',
    conversation: [{ role: 'user', content: 'Weather in Paris please' }],
    capabilities: {
        canReact: true,
        canGenerateImages: true,
        canUseTts: true,
    },
    ...overrides,
});

const createPlannerStepResult = (
    overrides: Partial<PlannerStepResult> = {}
): PlannerStepResult => ({
    plan: {
        action: 'message',
        modality: 'text',
        requestedCapabilityProfile: 'strict-review',
        safetyTier: 'Low',
        reasoning: 'Need weather details.',
        generation: {
            reasoningEffort: 'low',
            verbosity: 'low',
            toolIntent: {
                toolName: 'weather_forecast',
                requested: true,
                input: {
                    location: {
                        type: 'place_query',
                        query: 'Paris',
                    },
                },
            },
            search: {
                query: 'Paris weather',
                contextSize: 'low',
                intent: 'current_facts',
            },
        },
    },
    execution: {
        status: 'executed',
        purpose: 'chat_orchestrator_action_selection',
        contractType: 'text_json',
        durationMs: 12,
    },
    ingestion: {
        outputApplyOutcome: 'accepted',
        fallbackTier: 'none',
        correctionCodes: [],
        outOfContractFields: [],
        authorityFieldAttempts: [],
    },
    diagnostics: {
        rawToolIntentPresent: true,
        normalizedToolIntentPresent: true,
        toolIntentRejected: false,
        toolIntentRejectionReasons: [],
        rawToolIntentName: 'weather_forecast',
        normalizedToolIntentName: 'weather_forecast',
    },
    ...overrides,
});

const createApplier = () => {
    const enabledProfiles = runtimeConfig.modelProfiles.catalog.filter(
        (profile) => profile.enabled
    );
    const searchCapableProfiles = enabledProfiles.filter(
        (profile) => profile.capabilities.canUseSearch
    );
    const enabledProfilesById = new Map(
        enabledProfiles.map((profile) => [profile.id, profile])
    );
    const defaultResponseProfile =
        enabledProfiles.find(
            (profile) =>
                profile.id === runtimeConfig.modelProfiles.defaultProfileId
        ) ?? enabledProfiles[0];
    assert.ok(defaultResponseProfile);

    return createPlannerResultApplier({
        enabledProfiles,
        searchCapableProfiles,
        enabledProfilesById,
        defaultResponseProfile,
        logger: {
            debug: () => undefined,
            warn: () => undefined,
        },
    });
};

test('PlannerResultApplier applies surface coercion for web requests', () => {
    const applier = createApplier();
    const output = applier({
        normalizedRequest: createChatRequest({ surface: 'web' }),
        plannerStepResult: createPlannerStepResult({
            plan: {
                ...createPlannerStepResult().plan,
                action: 'react',
                reaction: '👍',
            },
        }),
        clarificationContinuation: { kind: 'none' },
        resolvedExecutionPolicy: resolveExecutionContract({
            presetId: 'fast-direct',
        }).policyContract,
    });

    assert.equal(output.plan.action, 'message');
    assert.ok(output.surfacePolicy);
    assert.equal(output.plannerApplyOutcome, 'adjusted_by_policy');
});

test('PlannerResultApplier merges request generation overrides', () => {
    const applier = createApplier();
    const output = applier({
        normalizedRequest: createChatRequest({
            generation: {
                reasoningEffort: 'high',
                verbosity: 'high',
            },
        }),
        plannerStepResult: createPlannerStepResult(),
        clarificationContinuation: { kind: 'none' },
        resolvedExecutionPolicy: resolveExecutionContract({
            presetId: 'balanced',
        }).policyContract,
    });

    assert.equal(output.generationForExecution.reasoningEffort, 'high');
    assert.equal(output.generationForExecution.verbosity, 'high');
});

test('PlannerResultApplier enforces single-tool policy and derives weather context-step request', () => {
    const applier = createApplier();
    const output = applier({
        normalizedRequest: createChatRequest(),
        plannerStepResult: createPlannerStepResult(),
        clarificationContinuation: { kind: 'none' },
        resolvedExecutionPolicy: resolveExecutionContract({
            presetId: 'quality-grounded',
        }).policyContract,
    });

    assert.equal(output.toolRequestContext.toolName, 'weather_forecast');
    assert.equal(output.toolRequestContext.requested, true);
    assert.equal(
        output.contextStepRequest?.integrationName,
        'weather_forecast'
    );
    assert.equal(output.generationForExecution.search, undefined);
});

test('PlannerResultApplier resolves profile and keeps planner suggestions non-authoritative', () => {
    const applier = createApplier();
    const output = applier({
        normalizedRequest: createChatRequest({
            profileId: runtimeConfig.modelProfiles.defaultProfileId,
        }),
        plannerStepResult: createPlannerStepResult({
            plan: {
                ...createPlannerStepResult().plan,
                requestedCapabilityProfile: 'strict-review',
            },
        }),
        clarificationContinuation: { kind: 'none' },
        resolvedExecutionPolicy: resolveExecutionContract({
            presetId: 'fast-direct',
        }).policyContract,
    });

    assert.equal(typeof output.selectedResponseProfile.id, 'string');
    assert.equal(output.plan.profileId, output.selectedResponseProfile.id);
    assert.equal(output.plannerApplyOutcome, 'adjusted_by_policy');
});
