/**
 * @description: Normalizes backend-owned steerability decisions into one inspectable metadata record.
 * @footnote-scope: core
 * @footnote-module: SteerabilityControls
 * @footnote-risk: medium - Incorrect control mapping can misstate which runtime choices affected execution.
 * @footnote-ethics: high - Misreported controls can reduce transparency and weaken operator governance.
 */
import type {
    SteerabilityControlRecord,
    SteerabilityControlSource,
    SteerabilityControls,
    ToolInvocationRequest,
    WorkflowModeDecision,
} from '@footnote/contracts/ethics-core';
import { deriveReviewIntensityFromWorkflowBehavior } from './workflowProfileRegistry.js';

type ProfileSelection = {
    profileId: string;
    provider: string;
    model: string;
};

type PersonaSelection = {
    personaId: string;
    overlaySource: 'none' | 'inline' | 'file';
};

export type BuildSteerabilityControlsInput = {
    // Canonical mode decision already resolved by workflow registry.
    workflowMode: WorkflowModeDecision;
    // Effective Execution Contract response mode that governed this run.
    executionContractResponseMode: 'fast_direct' | 'quality_grounded';
    // Optional caller-specified profile request (for example /chat override).
    requestedProfileId?: string;
    // Optional planner advisory profile from planning phase.
    plannerSelectedProfileId?: string;
    // Final runtime-selected profile after capability/policy fallback logic.
    selectedProfile: ProfileSelection;
    // Effective persona selection used for prompt composition.
    persona: PersonaSelection;
    // Orchestrator tool eligibility decision for this run.
    toolRequest: ToolInvocationRequest;
};

/**
 * Converts workflow-mode selection source into steerability source vocabulary.
 * This keeps mode lineage readable in one short enum field.
 */
const mapWorkflowModeSource = (
    selectedBy: WorkflowModeDecision['selectedBy']
): SteerabilityControlSource => {
    if (selectedBy === 'requested_mode') {
        return 'runtime_config';
    }
    if (selectedBy === 'inferred_from_execution_contract') {
        return 'execution_contract';
    }
    return 'fail_open_default';
};

const trimOptional = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

type ProviderPreferenceState =
    | 'requested_honored'
    | 'requested_overridden'
    | 'advisory_honored'
    | 'advisory_overridden'
    | 'fallback_resolved';

/**
 * Provider preference is intentionally honest about intent vs outcome:
 * - requested/advisory origin
 * - honored/overridden/fallback resolution
 *
 * This is not a policy command language; it is traceable outcome metadata.
 */
const buildProviderPreferenceControl = (
    input: BuildSteerabilityControlsInput
): SteerabilityControlRecord => {
    const requestedProfileId = trimOptional(input.requestedProfileId);
    const plannerSelectedProfileId = trimOptional(
        input.plannerSelectedProfileId
    );

    if (requestedProfileId !== undefined) {
        const state: ProviderPreferenceState =
            requestedProfileId === input.selectedProfile.profileId
                ? 'requested_honored'
                : 'requested_overridden';
        return {
            controlId: 'provider_preference',
            value: `state:${state};requested:${requestedProfileId};resolved:${input.selectedProfile.profileId}(${input.selectedProfile.provider}/${input.selectedProfile.model})`,
            source: 'request_override',
            rationale:
                state === 'requested_honored'
                    ? 'Caller requested a profile override and runtime honored it for provider/model selection.'
                    : 'Caller requested a profile override, but runtime policy/capability resolution overrode it and selected a different profile.',
            mattered: true,
            impactedTargets: ['model_profile_selection'],
        };
    }

    if (plannerSelectedProfileId !== undefined) {
        const state: ProviderPreferenceState =
            plannerSelectedProfileId === input.selectedProfile.profileId
                ? 'advisory_honored'
                : 'advisory_overridden';
        return {
            controlId: 'provider_preference',
            value: `state:${state};advisory:${plannerSelectedProfileId};resolved:${input.selectedProfile.profileId}(${input.selectedProfile.provider}/${input.selectedProfile.model})`,
            source: 'planner_output',
            rationale:
                state === 'advisory_honored'
                    ? 'Planner advisory profile preference aligned with capability policy and was used for provider/model selection.'
                    : 'Planner advisory profile preference was non-authoritative and runtime capability/policy resolution selected a different profile.',
            mattered: true,
            impactedTargets: ['model_profile_selection'],
        };
    }

    return {
        controlId: 'provider_preference',
        value: `state:fallback_resolved;resolved:${input.selectedProfile.profileId}(${input.selectedProfile.provider}/${input.selectedProfile.model})`,
        source: 'fail_open_default',
        rationale:
            'No requested or advisory profile preference was present, so runtime fallback resolution selected the provider/model profile.',
        mattered: true,
        impactedTargets: ['model_profile_selection'],
    };
};

const buildToolAllowanceControl = (
    toolRequest: ToolInvocationRequest
): SteerabilityControlRecord => {
    // If no tool was requested, the control record exists for inspectability
    // but has no causal execution impact for this run.
    if (!toolRequest.requested) {
        return {
            controlId: 'tool_allowance',
            value: `none_requested (${toolRequest.toolName})`,
            source: 'planner_output',
            rationale:
                'Planner did not request tool execution for this response path.',
            mattered: false,
            impactedTargets: [],
        };
    }

    if (toolRequest.eligible) {
        return {
            controlId: 'tool_allowance',
            value: `allowed:${toolRequest.toolName}`,
            source: 'tool_policy',
            rationale:
                'Requested tool passed capability/policy checks and remained eligible for execution.',
            mattered: true,
            impactedTargets: ['tool_eligibility'],
        };
    }

    return {
        controlId: 'tool_allowance',
        value: `blocked:${toolRequest.toolName}:${toolRequest.reasonCode ?? 'policy_blocked'}`,
        source: 'capability_policy',
        rationale:
            'Requested tool was blocked by capability or policy checks and did not execute.',
        mattered: true,
        impactedTargets: ['tool_eligibility'],
    };
};

/**
 * Builds the flat v1 steerability bundle.
 *
 * The shape is intentionally compact and serializable. We keep control classes
 * in docs for now (execution vs posture vs preference) without introducing a
 * nested runtime schema.
 */
export const buildSteerabilityControls = (
    input: BuildSteerabilityControlsInput
): SteerabilityControls => {
    const workflowModeSource = mapWorkflowModeSource(
        input.workflowMode.selectedBy
    );
    const reviewIntensity = deriveReviewIntensityFromWorkflowBehavior(
        input.workflowMode.behavior
    );
    const personaHasOverlay = input.persona.overlaySource !== 'none';

    const controls: SteerabilityControlRecord[] = [
        {
            controlId: 'workflow_mode',
            value: input.workflowMode.modeId,
            source: workflowModeSource,
            rationale: input.workflowMode.selectionReason,
            mattered: true,
            impactedTargets: [
                'workflow_execution',
                'execution_contract_selection',
                'review_loop_execution',
            ],
        },
        {
            controlId: 'evidence_strictness',
            value: input.workflowMode.behavior.evidencePosture,
            source: workflowModeSource,
            rationale: `Workflow mode mapped evidence posture to "${input.workflowMode.behavior.evidencePosture}" and Execution Contract response mode "${input.executionContractResponseMode}".`,
            mattered: true,
            impactedTargets: ['execution_contract_selection'],
        },
        {
            controlId: 'review_intensity',
            value: reviewIntensity,
            source: workflowModeSource,
            rationale: `Workflow mode review settings yielded intensity "${reviewIntensity}" (max deliberation calls: ${input.workflowMode.behavior.maxDeliberationCalls}).`,
            // `mattered` means observable causal impact on this run, not just
            // requested/present metadata.
            mattered: reviewIntensity !== 'none',
            impactedTargets:
                reviewIntensity !== 'none' ? ['review_loop_execution'] : [],
        },
        buildProviderPreferenceControl(input),
        {
            controlId: 'persona_tone_overlay',
            value: `${input.persona.personaId}:${input.persona.overlaySource}`,
            source: 'surface_profile',
            rationale: personaHasOverlay
                ? 'Backend persona overlay shaped answer presentation/tone only; it did not change execution-contract authority, evidence posture, or review authority.'
                : 'No persona overlay was applied; default persona prompt path remained active and execution-policy authority stayed unchanged.',
            mattered: personaHasOverlay,
            impactedTargets: personaHasOverlay ? ['persona_prompt_layer'] : [],
        },
        buildToolAllowanceControl(input.toolRequest),
    ];

    return {
        version: 'v1',
        controls,
    };
};
