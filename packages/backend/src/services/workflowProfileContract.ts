/**
 * @description: Defines the canonical workflow profile contract and no-generation
 * handling taxonomy used before profile-registry rollout.
 * @footnote-scope: interface
 * @footnote-module: WorkflowProfileContract
 * @footnote-risk: low - Type-only contract drift can misalign implementation planning across profiles.
 * @footnote-ethics: medium - Incorrect no-generation semantics can hide blocked outcomes from callers and operators.
 */
import type {
    WorkflowTerminationReason,
    WorkflowStepKind,
} from '@footnote/contracts/ethics-core';

export type WorkflowProfileId =
    | 'bounded-review-v1'
    | 'generate-only-v1'
    | (string & {});

export type WorkflowProfilePolicyContract = {
    enablePlanning: boolean;
    enableToolUse: boolean;
    enableReplanning: boolean;
    enableGeneration?: boolean;
    enableAssessment: boolean;
    enableRevision: boolean;
};

export type WorkflowProfileExecutionLimitsContract = {
    maxWorkflowSteps: number;
    maxToolCalls: number;
    maxDeliberationCalls: number;
    maxTokensTotal: number;
    maxDurationMs: number;
};

/**
 * Canonical no-generation reason labels used before profile registry rollout.
 * Trigger: workflow completes without emitting a generation payload.
 * Consequence: chatService maps these labels to surfaced/internal handling.
 */
export type WorkflowNoGenerationReasonCode =
    | 'blocked_by_policy_before_generate'
    | 'generation_disabled_by_profile'
    | 'budget_exhausted_steps_before_generate'
    | 'budget_exhausted_tokens_before_generate'
    | 'budget_exhausted_time_before_generate'
    | 'executor_error_before_generate';

export type WorkflowNoGenerationDisposition =
    | 'surface_to_caller'
    | 'internal_termination';

export type WorkflowNoGenerationHandling = {
    reasonCode: WorkflowNoGenerationReasonCode;
    disposition: WorkflowNoGenerationDisposition;
    terminationReason: WorkflowTerminationReason;
};

/**
 * Single source of truth for no-generation disposition decisions.
 * Trigger: chatService classifies a workflow no-generation termination.
 * Consequence: determines whether we surface a fixed response or run internal fallback generation.
 */
export const WORKFLOW_NO_GENERATION_HANDLING_MAP: Readonly<
    Record<WorkflowNoGenerationReasonCode, WorkflowNoGenerationHandling>
> = {
    blocked_by_policy_before_generate: {
        reasonCode: 'blocked_by_policy_before_generate',
        disposition: 'surface_to_caller',
        terminationReason: 'transition_blocked_by_policy',
    },
    generation_disabled_by_profile: {
        reasonCode: 'generation_disabled_by_profile',
        disposition: 'surface_to_caller',
        terminationReason: 'transition_blocked_by_policy',
    },
    budget_exhausted_steps_before_generate: {
        reasonCode: 'budget_exhausted_steps_before_generate',
        disposition: 'internal_termination',
        terminationReason: 'budget_exhausted_steps',
    },
    budget_exhausted_tokens_before_generate: {
        reasonCode: 'budget_exhausted_tokens_before_generate',
        disposition: 'internal_termination',
        terminationReason: 'budget_exhausted_tokens',
    },
    budget_exhausted_time_before_generate: {
        reasonCode: 'budget_exhausted_time_before_generate',
        disposition: 'internal_termination',
        terminationReason: 'budget_exhausted_time',
    },
    executor_error_before_generate: {
        reasonCode: 'executor_error_before_generate',
        disposition: 'surface_to_caller',
        terminationReason: 'executor_error_fail_open',
    },
};

export type NoGenerationHandlingResolution =
    | {
          kind: 'mapped';
          reasonCode: WorkflowNoGenerationReasonCode;
          handling: WorkflowNoGenerationHandling;
      }
    | {
          kind: 'unsupported_termination_reason';
          terminationReason: WorkflowTerminationReason;
      };

/**
 * Exhaustive resolver from workflow termination reason to no-generation handling.
 * Trigger: a workflow returns outcome `no_generation`.
 * Consequence: unsupported reasons are explicit and never silently coerced.
 */
export const resolveNoGenerationHandlingFromTermination = (input: {
    terminationReason: WorkflowTerminationReason;
    generationEnabledByPolicy: boolean;
}): NoGenerationHandlingResolution => {
    if (input.terminationReason === 'transition_blocked_by_policy') {
        const reasonCode = input.generationEnabledByPolicy
            ? 'blocked_by_policy_before_generate'
            : 'generation_disabled_by_profile';
        return {
            kind: 'mapped',
            reasonCode,
            handling: WORKFLOW_NO_GENERATION_HANDLING_MAP[reasonCode],
        };
    }

    if (input.terminationReason === 'budget_exhausted_steps') {
        const reasonCode = 'budget_exhausted_steps_before_generate';
        return {
            kind: 'mapped',
            reasonCode,
            handling: WORKFLOW_NO_GENERATION_HANDLING_MAP[reasonCode],
        };
    }

    if (input.terminationReason === 'budget_exhausted_tokens') {
        const reasonCode = 'budget_exhausted_tokens_before_generate';
        return {
            kind: 'mapped',
            reasonCode,
            handling: WORKFLOW_NO_GENERATION_HANDLING_MAP[reasonCode],
        };
    }

    if (input.terminationReason === 'budget_exhausted_time') {
        const reasonCode = 'budget_exhausted_time_before_generate';
        return {
            kind: 'mapped',
            reasonCode,
            handling: WORKFLOW_NO_GENERATION_HANDLING_MAP[reasonCode],
        };
    }

    if (input.terminationReason === 'executor_error_fail_open') {
        const reasonCode = 'executor_error_before_generate';
        return {
            kind: 'mapped',
            reasonCode,
            handling: WORKFLOW_NO_GENERATION_HANDLING_MAP[reasonCode],
        };
    }

    return {
        kind: 'unsupported_termination_reason',
        terminationReason: input.terminationReason,
    };
};

export type WorkflowProfileContractV1 = {
    profileId: WorkflowProfileId;
    profileVersion: 'v1';
    displayName: string;
    workflowName: string;
    policy: WorkflowProfilePolicyContract;
    defaultLimits: WorkflowProfileExecutionLimitsContract;
    requiredHooks: {
        initialStep: WorkflowStepKind;
        canEmitGeneration: () => boolean;
        classifyNoGeneration: (
            reasonCode: WorkflowNoGenerationReasonCode
        ) => WorkflowNoGenerationHandling;
    };
    optionalExtensions?: {
        reviewDecisionPrompt?: string;
        revisionPromptPrefix?: string;
        parseReviewDecision?: (text: string) => {
            decision: 'finalize' | 'revise';
            reason: string;
        } | null;
        metadata?: Record<string, string | number | boolean | null>;
    };
};
