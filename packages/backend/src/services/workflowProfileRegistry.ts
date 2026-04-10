/**
 * @description: Resolves workflow profiles by id into Execution Contract-aligned workflow
 * policy presets and runtime hooks, with bounded-review fail-open fallback behavior.
 * @footnote-scope: core
 * @footnote-module: WorkflowProfileRegistry
 * @footnote-risk: medium - Incorrect profile resolution can alter runtime execution paths.
 * @footnote-ethics: medium - Wrong fallback behavior can hide profile intent from operators.
 */
import {
    DEFAULT_REVIEW_DECISION_PROMPT,
    DEFAULT_REVISION_PROMPT_PREFIX,
    parseReviewDecisionText,
} from './workflowEngine.js';
import type { ExecutionPolicyContract } from './executionPolicyContract.js';
import type {
    RuntimeWorkflowProfile,
    WorkflowProfileContract,
    WorkflowProfileId,
} from './workflowProfileContract.js';

type BuiltinWorkflowProfileId = 'bounded-review' | 'generate-only';

/**
 * Execution Contract workflow policy presets:
 * - quality-grounded: generate + assess + revise
 * - fast-direct: generate only
 *
 * Registry ownership here is assembly glue only: map profile ids to
 * contract-aligned workflow-step toggles plus runtime hooks. Profiles select one
 * preset and attach limits/hooks; they do not own contract ontology.
 */
const EXECUTION_CONTRACT_QUALITY_GROUNDED_WORKFLOW_POLICY_PRESET: Readonly<
    RuntimeWorkflowProfile['policy']
> = {
    enablePlanning: false,
    enableToolUse: false,
    enableReplanning: false,
    enableGeneration: true,
    enableAssessment: true,
    enableRevision: true,
};

const EXECUTION_CONTRACT_FAST_DIRECT_WORKFLOW_POLICY_PRESET: Readonly<
    RuntimeWorkflowProfile['policy']
> = {
    enablePlanning: false,
    enableToolUse: false,
    enableReplanning: false,
    enableGeneration: true,
    enableAssessment: false,
    enableRevision: false,
};

const QUALITY_GROUNDED_DEFAULT_LIMITS: Readonly<
    RuntimeWorkflowProfile['defaultLimits']
> = {
    maxWorkflowSteps: 4,
    maxToolCalls: 0,
    maxDeliberationCalls: 4,
    maxTokensTotal: Number.MAX_SAFE_INTEGER,
    maxDurationMs: 15000,
};

const FAST_DIRECT_DEFAULT_LIMITS: Readonly<
    RuntimeWorkflowProfile['defaultLimits']
> = {
    maxWorkflowSteps: 1,
    maxToolCalls: 0,
    maxDeliberationCalls: 0,
    maxTokensTotal: Number.MAX_SAFE_INTEGER,
    maxDurationMs: 15000,
};

const BOUNDED_REVIEW_WORKFLOW_PROFILE: RuntimeWorkflowProfile = {
    profileId: 'bounded-review',
    profileVersion: 'v1',
    displayName: 'Bounded Review',
    workflowName: 'message_with_review_loop',
    policy: EXECUTION_CONTRACT_QUALITY_GROUNDED_WORKFLOW_POLICY_PRESET,
    defaultLimits: QUALITY_GROUNDED_DEFAULT_LIMITS,
    optionalExtensions: {
        reviewDecisionPrompt: DEFAULT_REVIEW_DECISION_PROMPT,
        revisionPromptPrefix: DEFAULT_REVISION_PROMPT_PREFIX,
    },
    requiredHooks: {
        initialStep: 'generate',
        forceWorkflowExecution: false,
        canEmitGeneration: () => true,
        classifyNoGeneration: (reasonCode) => reasonCode,
    },
    parseReviewDecision: parseReviewDecisionText,
};

const GENERATE_ONLY_WORKFLOW_PROFILE: RuntimeWorkflowProfile = {
    profileId: 'generate-only',
    profileVersion: 'v1',
    displayName: 'Generate Only',
    workflowName: 'message_generate_only',
    policy: EXECUTION_CONTRACT_FAST_DIRECT_WORKFLOW_POLICY_PRESET,
    defaultLimits: FAST_DIRECT_DEFAULT_LIMITS,
    requiredHooks: {
        initialStep: 'generate',
        forceWorkflowExecution: true,
        canEmitGeneration: () => true,
        classifyNoGeneration: (reasonCode) => reasonCode,
    },
};

// Extension checklist (workflow profiles):
// 1) Add runtime profile entry here (contract + requiredHooks).
// 2) Keep unknown-id fail-open behavior in this module.
// 3) Add/adjust registry + chatService tests for execution/fallback behavior.
const BUILTIN_RUNTIME_WORKFLOW_PROFILES: Readonly<
    Record<BuiltinWorkflowProfileId, RuntimeWorkflowProfile>
> = {
    'bounded-review': BOUNDED_REVIEW_WORKFLOW_PROFILE,
    'generate-only': GENERATE_ONLY_WORKFLOW_PROFILE,
};

export const DEFAULT_RUNTIME_WORKFLOW_PROFILE_ID: BuiltinWorkflowProfileId =
    'bounded-review';

const isBuiltinWorkflowProfileId = (
    value: string
): value is BuiltinWorkflowProfileId =>
    value in BUILTIN_RUNTIME_WORKFLOW_PROFILES;

const normalizeRequestedProfileId = (
    profileId: string | null | undefined
): string | undefined => {
    const trimmedProfileId = profileId?.trim();
    return trimmedProfileId !== undefined && trimmedProfileId.length > 0
        ? trimmedProfileId
        : undefined;
};

const sanitizeNonNegativeInteger = (
    value: number,
    fallback: number
): number => {
    if (!Number.isFinite(value)) {
        return Math.max(0, Math.floor(fallback));
    }

    return Math.max(0, Math.floor(value));
};

const sanitizePositiveInteger = (value: number, fallback: number): number => {
    if (!Number.isFinite(value)) {
        return Math.max(1, Math.floor(fallback));
    }

    return Math.max(1, Math.floor(value));
};

const deriveDefaultMaxIterationsFromWorkflowSteps = (
    maxWorkflowSteps: number
): number => {
    if (!Number.isFinite(maxWorkflowSteps)) {
        return 0;
    }

    const normalizedSteps = Math.max(1, Math.floor(maxWorkflowSteps));
    if (normalizedSteps <= 1) {
        return 0;
    }

    return Math.ceil(normalizedSteps / 2);
};

const toWorkflowProfileContract = (
    runtimeProfile: RuntimeWorkflowProfile
): WorkflowProfileContract => ({
    profileId: runtimeProfile.profileId,
    profileVersion: runtimeProfile.profileVersion,
    displayName: runtimeProfile.displayName,
    workflowName: runtimeProfile.workflowName,
    policy: runtimeProfile.policy,
    defaultLimits: runtimeProfile.defaultLimits,
    ...(runtimeProfile.optionalExtensions !== undefined && {
        optionalExtensions: runtimeProfile.optionalExtensions,
    }),
});

export type WorkflowProfileRegistryResolution = {
    requestedProfileId?: string;
    isKnownProfileId: boolean;
    runtimeProfile: RuntimeWorkflowProfile;
    profileContract: WorkflowProfileContract;
};

/**
 * Resolves one workflow profile id into both runtime and serializable shapes.
 *
 * Invariants:
 * - Input is trimmed before lookup.
 * - Unknown/blank ids fail open to `DEFAULT_RUNTIME_WORKFLOW_PROFILE_ID`.
 * - `requestedProfileId` may differ from `runtimeProfile.profileId` when
 *   fallback is applied.
 *
 * This function is registry assembly glue and is not a policy ontology owner.
 */
export const resolveWorkflowProfileRegistry = (
    profileId: string | null | undefined
): WorkflowProfileRegistryResolution => {
    const requestedProfileId = normalizeRequestedProfileId(profileId);
    if (
        requestedProfileId !== undefined &&
        isBuiltinWorkflowProfileId(requestedProfileId)
    ) {
        const runtimeProfile =
            BUILTIN_RUNTIME_WORKFLOW_PROFILES[requestedProfileId];
        return {
            requestedProfileId,
            isKnownProfileId: true,
            runtimeProfile,
            profileContract: toWorkflowProfileContract(runtimeProfile),
        };
    }

    const runtimeProfile =
        BUILTIN_RUNTIME_WORKFLOW_PROFILES[DEFAULT_RUNTIME_WORKFLOW_PROFILE_ID];
    return {
        ...(requestedProfileId !== undefined && { requestedProfileId }),
        isKnownProfileId: false,
        runtimeProfile,
        profileContract: toWorkflowProfileContract(runtimeProfile),
    };
};

export type ResolvedWorkflowRuntimeConfig = {
    requestedProfileId: WorkflowProfileId;
    profileId: WorkflowProfileId;
    runtimeProfile: RuntimeWorkflowProfile;
    profileContract: WorkflowProfileContract;
    workflowExecutionEnabled: boolean;
    workflowExecutionLimits: RuntimeWorkflowProfile['defaultLimits'];
};

/**
 * Resolves chat workflow runtime execution settings from config + profile
 * policy.
 *
 * Invariants:
 * - This is the single workflow-execution gating assembly surface for chat runtime.
 * - Callers should not branch on workflow profile ids directly.
 * - `forceWorkflowExecution` is the explicit profile-level override for
 *   workflow execution when review-loop gating would otherwise disable it.
 *
 * This resolver composes runtime config from contracts; it does not define
 * Execution Contract ontology.
 */
export const resolveWorkflowRuntimeConfig = (input: {
    profileId: string | null | undefined;
    reviewLoopEnabled: boolean;
    maxIterations: number;
    maxDurationMs: number;
    executionPolicyContract?: Pick<
        ExecutionPolicyContract,
        'response' | 'limits'
    >;
}): ResolvedWorkflowRuntimeConfig => {
    const requestedProfileId =
        input.profileId ?? DEFAULT_RUNTIME_WORKFLOW_PROFILE_ID;
    const profileResolution =
        resolveWorkflowProfileRegistry(requestedProfileId);
    const workflowProfile = profileResolution.runtimeProfile;
    const executionPolicy = input.executionPolicyContract;
    const executionEnabledByPolicy =
        executionPolicy !== undefined
            ? executionPolicy.response.responseMode === 'quality_grounded'
            : input.reviewLoopEnabled === true;
    const workflowExecutionEnabled =
        workflowProfile.requiredHooks.forceWorkflowExecution ||
        executionEnabledByPolicy;
    const profileDefaultMaxIterations =
        deriveDefaultMaxIterationsFromWorkflowSteps(
            workflowProfile.defaultLimits.maxWorkflowSteps
        );
    const fallbackWorkflowStepLimit =
        workflowProfile.policy.enableAssessment === false
            ? 1
            : Math.max(1, profileDefaultMaxIterations * 2);
    const workflowExecutionLimits: RuntimeWorkflowProfile['defaultLimits'] = {
        maxWorkflowSteps: sanitizePositiveInteger(
            executionPolicy?.limits.maxWorkflowSteps ??
                (workflowProfile.policy.enableAssessment === false
                    ? 1
                    : input.maxIterations * 2),
            fallbackWorkflowStepLimit
        ),
        maxToolCalls: sanitizeNonNegativeInteger(
            executionPolicy?.limits.maxToolCalls ??
                workflowProfile.defaultLimits.maxToolCalls,
            workflowProfile.defaultLimits.maxToolCalls
        ),
        maxDeliberationCalls: sanitizeNonNegativeInteger(
            executionPolicy?.limits.maxDeliberationCalls ??
                (workflowProfile.policy.enableAssessment === false
                    ? 0
                    : input.maxIterations * 2),
            workflowProfile.defaultLimits.maxDeliberationCalls
        ),
        maxTokensTotal: sanitizeNonNegativeInteger(
            executionPolicy?.limits.maxTokensTotal ??
                workflowProfile.defaultLimits.maxTokensTotal,
            workflowProfile.defaultLimits.maxTokensTotal
        ),
        maxDurationMs: sanitizePositiveInteger(
            executionPolicy?.limits.maxDurationMs ?? input.maxDurationMs,
            workflowProfile.defaultLimits.maxDurationMs
        ),
    };

    return {
        requestedProfileId,
        profileId: workflowProfile.profileId,
        runtimeProfile: workflowProfile,
        profileContract: profileResolution.profileContract,
        workflowExecutionEnabled,
        workflowExecutionLimits,
    };
};
