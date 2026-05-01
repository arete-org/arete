/**
 * @description: Defines planner workflow seam contracts used to keep workflow
 * timing ownership separate from planner execution and policy application.
 * @footnote-scope: interface
 * @footnote-module: PlannerWorkflowSeams
 * @footnote-risk: medium - Contract drift can desync planner-step handoff across runtime layers.
 * @footnote-ethics: high - Clear seam ownership preserves planner-advisory boundaries and policy authority.
 */
import type {
    ExecutionReasonCode,
    ExecutionStatus,
    PlannerExecutionApplyOutcome,
    PlannerExecutionContractType,
    PlannerExecutionPurpose,
    ToolExecutionContext,
    ToolInvocationRequest,
    SteerabilityControlId,
} from '@footnote/contracts/ethics-core';
import type { ModelProfile } from '@footnote/contracts';
import type {
    ChatImageRequest,
    PostChatRequest,
} from '@footnote/contracts/web';
import type {
    GenerationRequest,
    RuntimeMessage,
} from '@footnote/agent-runtime';
import type {
    ChatPlan,
    ChatPlannerCapabilityProfileOption,
    PlannerToolIntentDiagnostics,
} from './chatPlanner.js';
import type { ChatPlannerInvocationContext } from './chatPlannerInvocation.js';
import type { ChatGenerationPlan } from './chatGenerationTypes.js';
import type { ChatSurfacePolicyCoercion } from './chatSurfacePolicy.js';
import type { CapabilityProfileId } from './modelCapabilityPolicy.js';
import type { ContextStepRequest } from './workflowEngine.js';

/** Workflow engine sends this to PlannerStepExecutor for the plan step. */
export type PlannerStepRequest = {
    workflowId: string;
    workflowName: string;
    attempt: number;
    request: PostChatRequest;
    invocationContext: ChatPlannerInvocationContext;
    capabilityProfiles: ChatPlannerCapabilityProfileOption[];
};

/**
 * Planner step output.
 * `execution.status` is the source of truth for whether planner output was usable.
 */
export type PlannerStepResult = {
    plan: ChatPlan;
    execution: {
        status: ExecutionStatus;
        reasonCode?: ExecutionReasonCode;
        purpose: PlannerExecutionPurpose;
        contractType: PlannerExecutionContractType;
        durationMs: number;
        profileId?: string;
        provider?: string;
        model?: string;
    };
    ingestion: {
        outputApplyOutcome: 'accepted' | 'partially_applied' | 'rejected';
        fallbackTier: 'none' | 'field_corrections' | 'safe_default_plan';
        correctionCodes: string[];
        outOfContractFields: string[];
        authorityFieldAttempts: string[];
    };
    diagnostics: PlannerToolIntentDiagnostics;
};

export type PlannerStepExecutor = (
    input: PlannerStepRequest
) => Promise<PlannerStepResult>;

/** Terminal action intent. chatService converts this into the actual response shape. */
export type PlanTerminalAction =
    | {
          responseAction: 'ignore';
      }
    | {
          responseAction: 'react';
          reaction: string;
      }
    | {
          responseAction: 'image';
          imageRequest: ChatImageRequest;
      };

/** Input to PlannerResultApplier. Orchestrator passes request + planner step output. */
export type PlannerApplicationInput = {
    normalizedRequest: PostChatRequest;
    plannerStepResult: PlannerStepResult;
};

/**
 * Policy-applied planner state.
 * Planner suggestions are already bounded by backend policy in this object.
 */
export type PlannerApplicationResult = {
    plan: ChatPlan;
    surfacePolicy?: ChatSurfacePolicyCoercion;
    generationForExecution: ChatGenerationPlan;
    selectedResponseProfile: ModelProfile;
    originalSelectedProfileId: string;
    effectiveSelectedProfileId: string;
    rerouteApplied: boolean;
    selectedCapabilityProfile?: CapabilityProfileId;
    capabilityReasonCode?: string;
    toolRequestContext: ToolInvocationRequest;
    toolExecutionContext?: ToolExecutionContext;
    contextStepRequest?: ContextStepRequest;
    plannerApplyOutcome: PlannerExecutionApplyOutcome;
    plannerMattered: boolean;
    plannerMatteredControlIds: SteerabilityControlId[];
    fallbackReasons: string[];
    fallbackRollupSelectionSource: 'default' | 'planner' | 'request_override';
};

export type PlannerResultApplier = (
    input: PlannerApplicationInput
) => PlannerApplicationResult;

export type PlanContinuationBuilderInput = {
    plannerStepResult: PlannerStepResult;
    workflowId: string;
    workflowName: string;
    attempt: number;
    baseMessagesWithHints: RuntimeMessage[];
    baseGenerationRequest: GenerationRequest;
};

export type PostPlannerDiagnosticsSummary = Pick<
    PlannerToolIntentDiagnostics,
    | 'rawToolIntentPresent'
    | 'rawToolIntentName'
    | 'normalizedToolIntentPresent'
    | 'normalizedToolIntentName'
    | 'toolIntentRejected'
    | 'toolIntentRejectionReasons'
>;

export type AppliedPlanState = {
    executionPlan: ChatPlan;
    generationForExecution: ChatGenerationPlan;
    selectedResponseProfile: Pick<
        ModelProfile,
        'id' | 'provider' | 'providerModel' | 'capabilities'
    >;
    originalSelectedProfileId: string;
    effectiveSelectedProfileId: string;
    selectedCapabilityProfile?: CapabilityProfileId;
    capabilityReasonCode?: string;
    toolRequestContext: ToolInvocationRequest;
    toolExecutionContext?: ToolExecutionContext;
    plannerDiagnostics: PostPlannerDiagnosticsSummary;
    plannerApplyOutcome: PlannerExecutionApplyOutcome;
    plannerMattered: boolean;
    plannerMatteredControlIds: SteerabilityControlId[];
    fallbackReasons: string[];
    fallbackRollupSelectionSource: 'default' | 'planner' | 'request_override';
    modality: ChatPlan['modality'];
    safetyTier: ChatPlan['safetyTier'];
    searchRequested: boolean;
};

export type PlanContinuation = {
    /** Canonical post-plan state used for metadata and downstream telemetry. */
    plannerSummary: AppliedPlanState;
} & (
    | {
          continuation: 'terminal_action';
          terminalAction: PlanTerminalAction;
      }
    | {
          continuation: 'continue_message';
          messagesWithHints: RuntimeMessage[];
          generationRequest: GenerationRequest;
          conversationSnapshot: string;
          contextStepRequest?: ContextStepRequest;
      }
);

/** Builds the next workflow action after policy application. */
export type PlanContinuationBuilder = (
    input: PlanContinuationBuilderInput
) => PlanContinuation;
