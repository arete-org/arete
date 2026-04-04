/**
 * @description: Defines serializable workflow profile contracts and the
 * no-generation handling taxonomy.
 *
 * A workflow is one bounded backend execution loop: generate, optionally assess,
 * optionally revise, then terminate with lineage metadata. A workflow profile is
 * the config and hook bundle that selects which of those steps are allowed and
 * how "no generation happened" should be classified.
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
 * Built-in ids stay literal for autocomplete. The string extension leaves room
 * for new profile ids before a registry exists.
 */
export type WorkflowProfileId =
    | 'bounded-review'
    | 'generate-only'
    | (string & {});

/**
 * Policy switches checked by the engine before each workflow transition.
 *
 * `enableGeneration` stays optional because current callers still rely on the
 * engine default when that flag is omitted.
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
 * Each code names what stopped the first successful generate step, so lineage
 * can distinguish policy blocks, budget exhaustion, and executor failures.
 */
export type WorkflowNoGenerationReasonCode =
    | 'blocked_by_policy_before_generate' // A policy transition check blocked generate before first draft.
    | 'generation_disabled_by_profile' // Profile-level config disabled generation for this workflow.
    | 'budget_exhausted_steps_before_generate' // Step budget ended before first generate step could run.
    | 'budget_exhausted_tokens_before_generate' // Token budget ended before first generate step could run.
    | 'budget_exhausted_time_before_generate' // Time budget ended before first generate step could run.
    | 'executor_error_before_generate'; // Runtime/executor failed before any successful generation.

/**
 * Runtime action for a no-generation outcome.
 *
 * `return_no_generation` returns an explicit blocked/no-generation response.
 * `run_fallback_generation` records the original stop reason in lineage, then
 * allows chat runtime to generate a deterministic fallback response.
 */
export type WorkflowNoGenerationRuntimeAction =
    | 'return_no_generation'
    | 'run_fallback_generation';

/**
 * Handling directive resolved for one no-generation reason code.
 *
 * `terminationReason` is the value persisted into workflow lineage metadata.
 */
export type WorkflowNoGenerationHandling = {
    reasonCode: WorkflowNoGenerationReasonCode;
    runtimeAction: WorkflowNoGenerationRuntimeAction;
    terminationReason: WorkflowTerminationReason;
};

/**
 * Required handling matrix for every no-generation reason code.
 */
export const WORKFLOW_NO_GENERATION_HANDLING_MAP: Readonly<
    Record<WorkflowNoGenerationReasonCode, WorkflowNoGenerationHandling>
> = {
    blocked_by_policy_before_generate: {
        reasonCode: 'blocked_by_policy_before_generate',
        // Policy blocked the first draft, so return no-generation directly.
        // Keep the policy stop reason in lineage; do not synthesize fallback output.
        runtimeAction: 'return_no_generation',
        terminationReason: 'transition_blocked_by_policy',
    },
    generation_disabled_by_profile: {
        reasonCode: 'generation_disabled_by_profile',
        // This profile does not allow generation, so return no-generation directly.
        // Keep the policy stop reason in lineage for accurate operator context.
        runtimeAction: 'return_no_generation',
        terminationReason: 'transition_blocked_by_policy',
    },
    budget_exhausted_steps_before_generate: {
        reasonCode: 'budget_exhausted_steps_before_generate',
        // Step budget ran out before first draft, so fallback may still answer briefly.
        // Preserve the budget stop reason in lineage even when fallback succeeds.
        runtimeAction: 'run_fallback_generation',
        terminationReason: 'budget_exhausted_steps',
    },
    budget_exhausted_tokens_before_generate: {
        reasonCode: 'budget_exhausted_tokens_before_generate',
        // Token budget ran out before first draft, so fallback may still answer briefly.
        // Preserve the budget stop reason in lineage even when fallback succeeds.
        runtimeAction: 'run_fallback_generation',
        terminationReason: 'budget_exhausted_tokens',
    },
    budget_exhausted_time_before_generate: {
        reasonCode: 'budget_exhausted_time_before_generate',
        // Time budget expired before first draft, so fallback may still answer briefly.
        // Preserve the timeout reason in lineage even when fallback succeeds.
        runtimeAction: 'run_fallback_generation',
        terminationReason: 'budget_exhausted_time',
    },
    executor_error_before_generate: {
        reasonCode: 'executor_error_before_generate',
        // Execution failed before first draft, so return no-generation directly.
        // Keep executor failure in lineage so debugging does not depend on transport.
        runtimeAction: 'return_no_generation',
        terminationReason: 'executor_error_fail_open',
    },
};

/**
 * Result of mapping a workflow termination reason to no-generation handling.
 *
 * `unsupported_termination_reason` is explicit so callers do not silently
 * coerce an unmapped workflow reason into the wrong no-generation behavior.
 */
export type NoGenerationHandlingResolution =
    | {
          /** This termination reason has an explicit map entry. */
          kind: 'mapped';
          /** Reason code selected from termination reason + generation policy. */
          reasonCode: WorkflowNoGenerationReasonCode;
          /** Handling directive read from `WORKFLOW_NO_GENERATION_HANDLING_MAP`. */
          handling: WorkflowNoGenerationHandling;
      }
    | {
          /** No no-generation mapping exists for this termination reason. */
          kind: 'unsupported_termination_reason';
          /** Original workflow reason preserved for lineage and fallback logic. */
          terminationReason: WorkflowTerminationReason;
      };

/**
 * Resolves a workflow termination reason into a no-generation handling decision.
 *
 * Call this only when the workflow ended before any successful generation. The
 * result tells chat runtime whether to surface that outcome or run fallback.
 */
export const resolveNoGenerationHandlingFromTermination = (input: {
    terminationReason: WorkflowTerminationReason;
    generationEnabledByPolicy: boolean;
}): NoGenerationHandlingResolution => {
    // A single policy termination reason can come from two causes:
    // generation explicitly disabled by profile, or another policy block before generate.
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
        const reasonCode = input.generationEnabledByPolicy
            ? 'budget_exhausted_steps_before_generate'
            : 'generation_disabled_by_profile';
        return {
            kind: 'mapped',
            reasonCode,
            handling: WORKFLOW_NO_GENERATION_HANDLING_MAP[reasonCode],
        };
    }

    if (input.terminationReason === 'budget_exhausted_tokens') {
        const reasonCode = input.generationEnabledByPolicy
            ? 'budget_exhausted_tokens_before_generate'
            : 'generation_disabled_by_profile';
        return {
            kind: 'mapped',
            reasonCode,
            handling: WORKFLOW_NO_GENERATION_HANDLING_MAP[reasonCode],
        };
    }

    if (input.terminationReason === 'budget_exhausted_time') {
        const reasonCode = input.generationEnabledByPolicy
            ? 'budget_exhausted_time_before_generate'
            : 'generation_disabled_by_profile';
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
 * Serializable workflow profile contract shape.
 *
 * This exported type is data-only so it can cross process/API boundaries
 * without carrying executable hooks.
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
    optionalExtensions?: {
        /** Optional review prompt template used by review-enabled strategies. */
        reviewDecisionPrompt?: string;
        /** Optional revision prefix injected before rewrite attempts. */
        revisionPromptPrefix?: string;
        /** Extensible serialized metadata for profile-specific diagnostics. */
        metadata?: Record<string, string | number | boolean | null>;
    };
};

/**
 * Internal runtime-only hooks for profile execution.
 *
 * Keep this separate from `WorkflowProfileContract` so public types remain
 * serializable and transport-safe.
 */
type WorkflowProfileRuntimeHooks = {
    requiredHooks: {
        initialStep: WorkflowStepKind;
        forceWorkflowExecution: boolean;
        canEmitGeneration: () => boolean;
        classifyNoGeneration: (
            reasonCode: WorkflowNoGenerationReasonCode
        ) => WorkflowNoGenerationReasonCode;
    };
    parseReviewDecision?: (text: string) => {
        decision: 'finalize' | 'revise';
        reason: string;
    } | null;
};

export type RuntimeWorkflowProfile = WorkflowProfileContract &
    WorkflowProfileRuntimeHooks;
