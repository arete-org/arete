/**
 * @description: Defines the workflow profile contract and no-generation
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

/**
 * Stable workflow-profile identifier used by backend orchestration config.
 */
export type WorkflowProfileId =
    | 'bounded-review'
    | 'generate-only'
    | (string & {});

/**
 * Backend policy toggles that control which workflow step kinds are legal.
 * `enableGeneration` is optional to match existing engine semantics.
 */
export type WorkflowProfilePolicyContract = {
    enablePlanning: boolean;
    enableToolUse: boolean;
    enableReplanning: boolean;
    enableGeneration?: boolean;
    enableAssessment: boolean;
    enableRevision: boolean;
};

/**
 * Quantitative workflow limits used by profile defaults.
 */
export type WorkflowProfileExecutionLimitsContract = {
    maxWorkflowSteps: number;
    maxToolCalls: number;
    maxDeliberationCalls: number;
    maxTokensTotal: number;
    maxDurationMs: number;
};

export type WorkflowNoGenerationReasonCode =
    | 'blocked_by_policy_before_generate' // A policy transition check blocked generate before first draft.
    | 'generation_disabled_by_profile' // Profile-level config disabled generation for this workflow.
    | 'budget_exhausted_steps_before_generate' // Step budget ended before first generate step could run.
    | 'budget_exhausted_tokens_before_generate' // Token budget ended before first generate step could run.
    | 'budget_exhausted_time_before_generate' // Time budget ended before first generate step could run.
    | 'executor_error_before_generate'; // Runtime/executor failed before any successful generation.

/**
 * Whether a no-generation outcome should be surfaced directly or handled
 * internally with deterministic fallback behavior.
 */
export type WorkflowNoGenerationDisposition =
    | 'surface_to_caller'
    | 'internal_termination';

/**
 * Resolved no-generation handling decision for one reason code.
 */
export type WorkflowNoGenerationHandling = {
    reasonCode: WorkflowNoGenerationReasonCode;
    disposition: WorkflowNoGenerationDisposition;
    terminationReason: WorkflowTerminationReason;
};

export const WORKFLOW_NO_GENERATION_HANDLING_MAP: Readonly<
    Record<WorkflowNoGenerationReasonCode, WorkflowNoGenerationHandling>
> = {
    blocked_by_policy_before_generate: {
        reasonCode: 'blocked_by_policy_before_generate',
        disposition: 'surface_to_caller', // Caller should see explicit blocked/no-generation response.
        terminationReason: 'transition_blocked_by_policy',
    },
    generation_disabled_by_profile: {
        reasonCode: 'generation_disabled_by_profile',
        disposition: 'surface_to_caller', // Caller should see explicit blocked/no-generation response.
        terminationReason: 'transition_blocked_by_policy',
    },
    budget_exhausted_steps_before_generate: {
        reasonCode: 'budget_exhausted_steps_before_generate',
        disposition: 'internal_termination', // Backend should attempt deterministic internal fallback generation.
        terminationReason: 'budget_exhausted_steps',
    },
    budget_exhausted_tokens_before_generate: {
        reasonCode: 'budget_exhausted_tokens_before_generate',
        disposition: 'internal_termination', // Backend should attempt deterministic internal fallback generation.
        terminationReason: 'budget_exhausted_tokens',
    },
    budget_exhausted_time_before_generate: {
        reasonCode: 'budget_exhausted_time_before_generate',
        disposition: 'internal_termination', // Backend should attempt deterministic internal fallback generation.
        terminationReason: 'budget_exhausted_time',
    },
    executor_error_before_generate: {
        reasonCode: 'executor_error_before_generate',
        disposition: 'surface_to_caller', // Caller should see explicit surfaced response for pre-generation failure.
        terminationReason: 'executor_error_fail_open',
    },
};

/**
 * Result shape returned by the termination-reason resolver.
 * `mapped` means runtime behavior can be selected directly from the map.
 * `unsupported_termination_reason` means the caller must choose an explicit
 * deterministic fallback path (no silent coercion).
 */
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

/**
 * Workflow profile contract shape.
 * Required hooks define minimal runtime behavior; optional extensions carry
 * profile-specific strategy details (for example review/revision prompts).
 */
export type WorkflowProfileContract = {
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
