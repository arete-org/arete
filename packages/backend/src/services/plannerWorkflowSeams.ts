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

/** Input to planner executor. Produced by workflow engine; caller provides request and context. */
export type PlannerStepRequest = {
    workflowId: string;
    workflowName: string;
    attempt: number;
    request: PostChatRequest;
    invocationContext: ChatPlannerInvocationContext;
    capabilityProfiles: ChatPlannerCapabilityProfileOption[];
};

/** Output from planner executor; fail-open on optional fields, execution.status is authoritative. */
export type PlannerStepResult = {
    plan: ChatPlan;
    execution: {
        status: ExecutionStatus;
        reasonCode?: ExecutionReasonCode;
        purpose: PlannerExecutionPurpose;
        contractType: PlannerExecutionContractType;
        durationMs: number;
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

/** Terminal transport actions from planner; intent-only, policy must render. */
export type PlannerTerminalAction =
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

/** Input to policy-owned planner result applier. Produced by orchestrator with request. */
export type PlannerApplicationInput = {
    normalizedRequest: PostChatRequest;
    plannerStepResult: PlannerStepResult;
};

/** Output from policy-owned result applier; plannerMattered indicates advisory influence. */
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
    plannerMatteredControlIds: string[];
    fallbackReasons: string[];
    fallbackRollupSelectionSource: 'default' | 'planner' | 'request_override';
};

export type PlannerResultApplier = (
    input: PlannerApplicationInput
) => PlannerApplicationResult;

export type PostPlannerWorkflowAdapterInput = {
    plannerStepResult: PlannerStepResult;
    workflowId: string;
    workflowName: string;
    attempt: number;
    baseMessagesWithHints: RuntimeMessage[];
    baseGenerationRequest: GenerationRequest;
};

export type PostPlannerWorkflowAdapterResult = {
    terminalAction?: PlannerTerminalAction;
    messagesWithHints: RuntimeMessage[];
    generationRequest: GenerationRequest;
    contextStepRequest?: ContextStepRequest;
    plannerApplication?: PlannerApplicationResult;
};

export type PostPlannerWorkflowAdapter = (
    input: PostPlannerWorkflowAdapterInput
) => PostPlannerWorkflowAdapterResult;
