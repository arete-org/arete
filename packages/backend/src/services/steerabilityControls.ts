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
    workflowMode: WorkflowModeDecision;
    executionContractResponseMode: 'fast_direct' | 'quality_grounded';
    requestedProfileId?: string;
    plannerSelectedProfileId?: string;
    selectedProfile: ProfileSelection;
    persona: PersonaSelection;
    toolRequest: ToolInvocationRequest;
};

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

const deriveReviewIntensity = (
    workflowMode: WorkflowModeDecision
): 'none' | 'light' | 'moderate' | 'high' => {
    if (
        workflowMode.behavior.reviewPass === 'excluded' ||
        workflowMode.behavior.workflowExecution === 'disabled'
    ) {
        return 'none';
    }

    if (workflowMode.behavior.maxDeliberationCalls <= 1) {
        return 'light';
    }
    if (workflowMode.behavior.maxDeliberationCalls <= 3) {
        return 'moderate';
    }
    return 'high';
};

const trimOptional = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const buildProviderPreferenceControl = (
    input: BuildSteerabilityControlsInput
): SteerabilityControlRecord => {
    const requestedProfileId = trimOptional(input.requestedProfileId);
    const plannerSelectedProfileId = trimOptional(
        input.plannerSelectedProfileId
    );

    if (requestedProfileId !== undefined) {
        return {
            controlId: 'provider_preference',
            value: `request:${requestedProfileId} -> selected:${input.selectedProfile.profileId} (${input.selectedProfile.provider}/${input.selectedProfile.model})`,
            source: 'request_override',
            rationale:
                'Request profile override was present, so provider/model selection honored request routing policy with fail-open fallback.',
            mattered: true,
            impactedTargets: ['model_profile_selection'],
        };
    }

    if (plannerSelectedProfileId !== undefined) {
        return {
            controlId: 'provider_preference',
            value: `planner:${plannerSelectedProfileId} -> selected:${input.selectedProfile.profileId} (${input.selectedProfile.provider}/${input.selectedProfile.model})`,
            source: 'planner_output',
            rationale:
                'Planner-selected capability profile guided provider/model selection, then capability policy resolved the final execution profile.',
            mattered: true,
            impactedTargets: ['model_profile_selection'],
        };
    }

    return {
        controlId: 'provider_preference',
        value: `selected:${input.selectedProfile.profileId} (${input.selectedProfile.provider}/${input.selectedProfile.model})`,
        source: 'fail_open_default',
        rationale:
            'No explicit request or planner profile preference was present, so runtime fallback profile selection was used.',
        mattered: true,
        impactedTargets: ['model_profile_selection'],
    };
};

const buildToolAllowanceControl = (
    toolRequest: ToolInvocationRequest
): SteerabilityControlRecord => {
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

export const buildSteerabilityControls = (
    input: BuildSteerabilityControlsInput
): SteerabilityControls => {
    const workflowModeSource = mapWorkflowModeSource(
        input.workflowMode.selectedBy
    );
    const reviewIntensity = deriveReviewIntensity(input.workflowMode);
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
                ? 'Backend persona overlay was applied to prompt assembly.'
                : 'No persona overlay was applied; default persona prompt path remained active.',
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
