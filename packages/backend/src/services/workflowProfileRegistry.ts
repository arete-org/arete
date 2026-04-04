/**
 * @description: Resolves workflow profiles by id into serializable contracts
 * and runtime-only hooks, with bounded-review fail-open fallback behavior.
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
import type {
    RuntimeWorkflowProfile,
    WorkflowProfileContract,
    WorkflowProfileId,
} from './workflowProfileContract.js';

type BuiltinWorkflowProfileId = 'bounded-review' | 'generate-only';

const BOUNDED_REVIEW_WORKFLOW_PROFILE: RuntimeWorkflowProfile = {
    profileId: 'bounded-review',
    profileVersion: 'v1',
    displayName: 'Bounded Review',
    workflowName: 'message_with_review_loop',
    policy: {
        enablePlanning: false,
        enableToolUse: false,
        enableReplanning: false,
        enableGeneration: true,
        enableAssessment: true,
        enableRevision: true,
    },
    defaultLimits: {
        maxWorkflowSteps: 4,
        maxToolCalls: 0,
        maxDeliberationCalls: 4,
        maxTokensTotal: Number.MAX_SAFE_INTEGER,
        maxDurationMs: 15000,
    },
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
    policy: {
        enablePlanning: false,
        enableToolUse: false,
        enableReplanning: false,
        enableGeneration: true,
        enableAssessment: false,
        enableRevision: false,
    },
    defaultLimits: {
        maxWorkflowSteps: 1,
        maxToolCalls: 0,
        maxDeliberationCalls: 0,
        maxTokensTotal: Number.MAX_SAFE_INTEGER,
        maxDurationMs: 15000,
    },
    requiredHooks: {
        initialStep: 'generate',
        forceWorkflowExecution: true,
        canEmitGeneration: () => true,
        classifyNoGeneration: (reasonCode) => reasonCode,
    },
};

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
 */
export const resolveWorkflowProfileRegistry = (
    profileId: string | null | undefined
): WorkflowProfileRegistryResolution => {
    const trimmedProfileId = profileId?.trim();
    if (
        trimmedProfileId !== undefined &&
        trimmedProfileId.length > 0 &&
        isBuiltinWorkflowProfileId(trimmedProfileId)
    ) {
        const runtimeProfile =
            BUILTIN_RUNTIME_WORKFLOW_PROFILES[trimmedProfileId];
        return {
            requestedProfileId: trimmedProfileId,
            isKnownProfileId: true,
            runtimeProfile,
            profileContract: toWorkflowProfileContract(runtimeProfile),
        };
    }

    const runtimeProfile =
        BUILTIN_RUNTIME_WORKFLOW_PROFILES[DEFAULT_RUNTIME_WORKFLOW_PROFILE_ID];
    return {
        ...(trimmedProfileId !== undefined &&
            trimmedProfileId.length > 0 && {
                requestedProfileId: trimmedProfileId,
            }),
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
    workflowMaxIterations: number;
    workflowMaxDurationMs: number;
};

/**
 * Resolves chat workflow runtime execution settings from config + profile
 * policy.
 *
 * Invariants:
 * - This is the single workflow-execution gating surface for chat runtime.
 * - Callers should not branch on workflow profile ids directly.
 * - `forceWorkflowExecution` is the explicit profile-level override for
 *   workflow execution when review-loop gating would otherwise disable it.
 */
export const resolveWorkflowRuntimeConfig = (input: {
    profileId: string | null | undefined;
    reviewLoopEnabled: boolean;
    maxIterations: number;
    maxDurationMs: number;
}): ResolvedWorkflowRuntimeConfig => {
    const requestedProfileId =
        input.profileId ?? DEFAULT_RUNTIME_WORKFLOW_PROFILE_ID;
    const profileResolution =
        resolveWorkflowProfileRegistry(requestedProfileId);
    const workflowProfile = profileResolution.runtimeProfile;
    const workflowExecutionEnabled =
        workflowProfile.requiredHooks.forceWorkflowExecution ||
        input.reviewLoopEnabled === true;
    const profileDefaultMaxIterations = workflowProfile.policy.enableAssessment
        ? deriveDefaultMaxIterationsFromWorkflowSteps(
              workflowProfile.defaultLimits.maxWorkflowSteps
          )
        : 0;
    const workflowMaxIterations = workflowProfile.policy.enableAssessment
        ? sanitizeNonNegativeInteger(
              input.maxIterations,
              profileDefaultMaxIterations
          )
        : 0;
    const workflowMaxDurationMs = sanitizePositiveInteger(
        input.maxDurationMs,
        workflowProfile.defaultLimits.maxDurationMs
    );

    return {
        requestedProfileId,
        profileId: workflowProfile.profileId,
        runtimeProfile: workflowProfile,
        profileContract: profileResolution.profileContract,
        workflowExecutionEnabled,
        workflowMaxIterations,
        workflowMaxDurationMs,
    };
};
