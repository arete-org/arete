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
 * Stable workflow profile identifier.
 *
 * Why this is open-ended:
 * we keep known built-in ids as a literal union for autocomplete and safety,
 * but also allow string extension for profile ids introduced outside this file.
 */
export type WorkflowProfileId =
    | 'bounded-review'
    | 'generate-only'
    | (string & {});

/**
 * Policy switches that decide which workflow actions are legal at runtime.
 *
 * Trigger:
 * the workflow engine checks these flags before allowing each transition.
 *
 * Consequence:
 * disabled capabilities terminate or redirect execution before unsafe/unsupported
 * steps run.
 *
 * Note:
 * `enableGeneration` stays optional to match existing engine behavior where some
 * call sites still omit it.
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

/**
 * Reason codes for "no output was generated" workflow outcomes.
 *
 * Each code answers one question:
 * "What stopped the first successful generate step from happening?"
 *
 * The goal is deterministic provenance. Operators and callers should be able to
 * distinguish policy blocks, budget exhaustion, and executor failures without
 * reading internal logs.
 */
export type WorkflowNoGenerationReasonCode =
    | 'blocked_by_policy_before_generate' // A policy transition check blocked generate before first draft.
    | 'generation_disabled_by_profile' // Profile-level config disabled generation for this workflow.
    | 'budget_exhausted_steps_before_generate' // Step budget ended before first generate step could run.
    | 'budget_exhausted_tokens_before_generate' // Token budget ended before first generate step could run.
    | 'budget_exhausted_time_before_generate' // Time budget ended before first generate step could run.
    | 'executor_error_before_generate'; // Runtime/executor failed before any successful generation.

/**
 * Disposition for a no-generation outcome.
 *
 * - `surface_to_caller`: return an explicit no-generation/blocked response path.
 * - `internal_termination`: handle internally (for example deterministic fallback
 *   generation) while preserving lineage of why the original flow ended.
 */
export type WorkflowNoGenerationDisposition =
    | 'surface_to_caller'
    | 'internal_termination';

/**
 * Handling directive resolved for one no-generation reason code.
 *
 * `terminationReason` must stay aligned with workflow lineage enums so metadata
 * can be serialized and validated consistently across backend and contracts.
 */
export type WorkflowNoGenerationHandling = {
    reasonCode: WorkflowNoGenerationReasonCode;
    disposition: WorkflowNoGenerationDisposition;
    terminationReason: WorkflowTerminationReason;
};

/**
 * Required no-generation handling matrix.
 *
 * This is the single source of truth for how each reason code behaves:
 * what callers see (`disposition`) and which lineage reason is recorded
 * (`terminationReason`).
 */
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
 * Result of mapping a workflow termination reason to no-generation handling.
 *
 * - `mapped`: this termination reason is supported and has explicit handling.
 * - `unsupported_termination_reason`: this reason is outside the no-generation
 *   map. Caller must choose a deterministic path explicitly; no silent remap.
 */
export type NoGenerationHandlingResolution =
    | {
          /**
           * Successful deterministic mapping.
           */
          kind: 'mapped';
          /**
           * No-generation reason selected by the resolver.
           */
          reasonCode: WorkflowNoGenerationReasonCode;
          /**
           * Handling directive pulled directly from the required map.
           */
          handling: WorkflowNoGenerationHandling;
      }
    | {
          /**
           * Explicit signal that no mapping exists for this termination reason.
           */
          kind: 'unsupported_termination_reason';
          /**
           * Original reason preserved for provenance and deterministic fallback.
           */
          terminationReason: WorkflowTerminationReason;
      };

/**
 * Resolves a workflow termination reason into a no-generation handling decision.
 *
 * Trigger:
 * call this when a workflow ended before any successful generation.
 *
 * Consequence:
 * runtime can deterministically decide whether to surface a no-generation
 * outcome to callers or continue with internal fallback behavior.
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

/**
 * Workflow profile contract shape.
 *
 * Required hooks define behavior the engine depends on for all profiles.
 * Optional extensions add profile-specific strategy details (for example
 * review/revision prompts) without changing base contract guarantees.
 */
export type WorkflowProfileContract = {
    /** Stable id used by config and profile selection logic. */
    profileId: WorkflowProfileId;
    /** Contract/schema version. Kept explicit so future breaking changes are typed. */
    profileVersion: 'v1';
    /** Human-readable label for logs and dashboards. */
    displayName: string;
    /** Workflow lineage name emitted into response metadata. */
    workflowName: string;
    /** Policy capability toggles enforced by transition checks. */
    policy: WorkflowProfilePolicyContract;
    /** Default execution ceilings applied when request-specific limits are absent. */
    defaultLimits: WorkflowProfileExecutionLimitsContract;
    requiredHooks: {
        /** First step kind when this profile starts execution. */
        initialStep: WorkflowStepKind;
        /** Indicates whether this profile can ever emit a generation step. */
        canEmitGeneration: () => boolean;
        /** Maps a no-generation reason code to its required handling directive. */
        classifyNoGeneration: (
            reasonCode: WorkflowNoGenerationReasonCode
        ) => WorkflowNoGenerationHandling;
    };
    optionalExtensions?: {
        /** Optional review prompt template used by review-enabled strategies. */
        reviewDecisionPrompt?: string;
        /** Optional revision prefix injected before rewrite attempts. */
        revisionPromptPrefix?: string;
        /** Optional parser for profile-specific review outputs. */
        parseReviewDecision?: (text: string) => {
            decision: 'finalize' | 'revise';
            reason: string;
        } | null;
        /** Extensible serialized metadata for profile-specific diagnostics. */
        metadata?: Record<string, string | number | boolean | null>;
    };
};
