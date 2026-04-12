/**
 * @description: Resolves workflow mode and workflow profile into concrete chat
 * runtime settings within Execution Contract guardrails.
 *
 * Mode chooses the kind of run. Profile chooses the executable workflow shape.
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
    ExecutionContract,
    ExecutionResponseMode,
} from './executionContract.js';
import type {
    WorkflowModeDecision,
    WorkflowModeId,
} from '@footnote/contracts/ethics-core';
import type {
    RuntimeWorkflowProfile,
    WorkflowProfileContract,
    WorkflowProfileId,
} from './workflowProfileContract.js';

type BuiltinWorkflowProfileId = 'bounded-review' | 'generate-only';
type BuiltinWorkflowModeId = WorkflowModeId;

/**
 * Workflow profiles are concrete executable shapes:
 * - reviewed (`bounded-review`): generate + assess + revise
 * - direct (`generate-only`): generate only
 *
 * Registry ownership here is assembly glue only:
 * - Mode resolution decides run kind and default posture.
 * - Profile resolution decides executable step shape.
 * - Execution Contract remains the governing contract language.
 * - Chat orchestrator remains the runtime coordinator.
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
const DEFAULT_WORKFLOW_MODE_ID: BuiltinWorkflowModeId = 'grounded';

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

const normalizeRequestedModeId = (
    modeId: string | null | undefined
): string | undefined => {
    const trimmedModeId = modeId?.trim();
    return trimmedModeId !== undefined && trimmedModeId.length > 0
        ? trimmedModeId
        : undefined;
};

type WorkflowModeBehavior = WorkflowModeDecision['behavior'];

const WORKFLOW_MODE_BEHAVIOR_MAP: Readonly<
    Record<BuiltinWorkflowModeId, WorkflowModeBehavior>
> = {
    fast: {
        executionContractPresetId: 'fast-direct',
        workflowProfileClass: 'direct',
        workflowProfileId: 'generate-only',
        workflowExecution: 'disabled',
        reviewPass: 'excluded',
        reviseStep: 'disallowed',
        evidencePosture: 'minimal',
        maxWorkflowSteps: 1,
        maxDeliberationCalls: 0,
    },
    balanced: {
        executionContractPresetId: 'balanced',
        workflowProfileClass: 'reviewed',
        workflowProfileId: 'bounded-review',
        workflowExecution: 'always',
        reviewPass: 'included',
        reviseStep: 'allowed',
        evidencePosture: 'balanced',
        maxWorkflowSteps: 4,
        maxDeliberationCalls: 2,
    },
    grounded: {
        executionContractPresetId: 'quality-grounded',
        workflowProfileClass: 'reviewed',
        workflowProfileId: 'bounded-review',
        workflowExecution: 'policy_gated',
        reviewPass: 'included',
        reviseStep: 'allowed',
        evidencePosture: 'strict',
        maxWorkflowSteps: 8,
        maxDeliberationCalls: 4,
    },
};

export type ReviewIntensity = 'none' | 'light' | 'moderate' | 'high';

/**
 * Canonical review-intensity derivation from workflow-mode behavior.
 * Any metadata/reporting layer should use this helper to avoid drift.
 *
 * Threshold intent:
 * - none: review path is disabled/excluded
 * - light: one deliberation pass
 * - moderate: two or three deliberation passes
 * - high: four or more deliberation passes
 */
export const deriveReviewIntensityFromWorkflowBehavior = (
    behavior: WorkflowModeBehavior
): ReviewIntensity => {
    if (
        behavior.reviewPass === 'excluded' ||
        behavior.workflowExecution === 'disabled'
    ) {
        return 'none';
    }

    if (behavior.maxDeliberationCalls <= 1) {
        return 'light';
    }
    if (behavior.maxDeliberationCalls <= 3) {
        return 'moderate';
    }
    return 'high';
};

const normalizeWorkflowModeId = (
    modeId: string
): {
    modeId: WorkflowModeId;
} | null => {
    if (modeId === 'fast' || modeId === 'balanced' || modeId === 'grounded') {
        return {
            modeId: modeId as WorkflowModeId,
        };
    }

    return null;
};

const inferWorkflowModeIdFromExecutionContract = (
    responseMode: ExecutionResponseMode | undefined
): BuiltinWorkflowModeId | undefined => {
    // TODO(workflow-mode-response-mode-extension): If ExecutionResponseMode adds
    // `balanced`, map it here so inference stays aligned with canonical mode ids.
    if (responseMode === 'quality_grounded') {
        return 'grounded';
    }
    if (responseMode === 'fast_direct') {
        return 'fast';
    }
    return undefined;
};

export type WorkflowModeResolution = {
    /** Final mode record used by downstream runtime assembly. */
    modeDecision: WorkflowModeDecision;
    /** Whether the request matched a built-in mode directly. */
    isKnownRequestedModeId: boolean;
};

/**
 * Resolves one initial workflow mode decision for this request.
 *
 * That decision drives execution preset, profile routing, review posture, and
 * metadata explanation.
 *
 * `modeDecision.modeId` is always the canonical high-level id
 * (`fast|balanced|grounded`).
 *
 * In v1, this initial mode decision is not revised later in runtime.
 */
export const resolveWorkflowModeDecision = (input: {
    modeId: string | null | undefined;
    executionContractResponseMode?: ExecutionResponseMode;
}): WorkflowModeResolution => {
    const requestedModeId = normalizeRequestedModeId(input.modeId);
    const normalizedRequestedMode =
        requestedModeId !== undefined
            ? normalizeWorkflowModeId(requestedModeId)
            : null;
    if (normalizedRequestedMode !== null) {
        return {
            isKnownRequestedModeId: true,
            modeDecision: {
                modeId: normalizedRequestedMode.modeId,
                selectedBy: 'requested_mode',
                selectionReason:
                    'Used requested workflow mode id from runtime configuration.',
                requestedModeId,
                ...(input.executionContractResponseMode !== undefined && {
                    executionContractResponseMode:
                        input.executionContractResponseMode,
                }),
                behavior:
                    WORKFLOW_MODE_BEHAVIOR_MAP[normalizedRequestedMode.modeId],
            },
        };
    }

    const inferredModeId = inferWorkflowModeIdFromExecutionContract(
        input.executionContractResponseMode
    );
    if (inferredModeId !== undefined) {
        return {
            isKnownRequestedModeId: false,
            modeDecision: {
                modeId: inferredModeId,
                selectedBy: 'inferred_from_execution_contract',
                selectionReason:
                    'Requested mode was missing or unknown, so mode was inferred from Execution Contract response mode.',
                ...(requestedModeId !== undefined && { requestedModeId }),
                executionContractResponseMode:
                    input.executionContractResponseMode,
                behavior: WORKFLOW_MODE_BEHAVIOR_MAP[inferredModeId],
            },
        };
    }

    return {
        isKnownRequestedModeId: false,
        modeDecision: {
            modeId: DEFAULT_WORKFLOW_MODE_ID,
            selectedBy: 'fail_open_default',
            selectionReason:
                'Requested mode and Execution Contract hint were unavailable, so fallback default mode was used.',
            ...(requestedModeId !== undefined && { requestedModeId }),
            behavior: WORKFLOW_MODE_BEHAVIOR_MAP[DEFAULT_WORKFLOW_MODE_ID],
        },
    };
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
    /** Runtime shape with hooks used by workflow execution. */
    runtimeProfile: RuntimeWorkflowProfile;
    /** Serializable mirror safe to expose beyond backend runtime. */
    profileContract: WorkflowProfileContract;
};

/**
 * Resolves one workflow profile id into both runtime and serializable shapes.
 *
 * Invariants:
 * - Input is trimmed before lookup.
 * - Unknown/blank ids fail open to `DEFAULT_RUNTIME_WORKFLOW_PROFILE_ID`.
 * - `requestedProfileId` may differ from `runtimeProfile.profileId` when
 *   fallback is applied at initial profile selection time.
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
    // TODO(workflow-mode-final-posture): If runtime mode revisability is added,
    // split mode metadata into initial and final ids instead of overloading one field.
    /** Requested mode after trimming. Falls back to the resolved mode id. */
    requestedModeId: string;
    modeId: WorkflowModeId;
    modeDecision: WorkflowModeDecision;
    profileId: WorkflowProfileId;
    runtimeProfile: RuntimeWorkflowProfile;
    profileContract: WorkflowProfileContract;
    workflowExecutionEnabled: boolean;
    workflowExecutionLimits: RuntimeWorkflowProfile['defaultLimits'];
};

/**
 * Resolves chat workflow runtime settings from initial mode routing +
 * profile policy.
 *
 * Invariants:
 * - This is the single workflow-execution gating assembly surface for chat runtime.
 * - Mode decides run kind first; profile decides executable shape second.
 * - Callers should not branch on workflow mode/profile ids directly.
 * - `forceWorkflowExecution` is the explicit profile-level override for
 *   workflow execution when review-loop gating would otherwise disable it.
 *
 * This resolver composes runtime config from contracts; it does not define
 * Execution Contract ontology.
 */
export const resolveWorkflowRuntimeConfig = (input: {
    modeId: string | null | undefined;
    reviewLoopEnabled: boolean;
    maxIterations: number;
    maxDurationMs: number;
    ExecutionContract?: Pick<ExecutionContract, 'response' | 'limits'>;
}): ResolvedWorkflowRuntimeConfig => {
    // TODO(workflow-mode-escalation-attachment): Initial mode selection is
    // not revisable in v1. Attach any future mode-escalation policy here so
    // routing revisions stay centralized instead of split across callers.
    const modeResolution = resolveWorkflowModeDecision({
        modeId: input.modeId,
        executionContractResponseMode:
            input.ExecutionContract?.response.responseMode,
    });
    const modeDecision = modeResolution.modeDecision;
    // Mode picks the posture first. The profile lookup then turns that posture
    // into a concrete executable workflow shape.
    const profileResolution = resolveWorkflowProfileRegistry(
        modeDecision.behavior.workflowProfileId
    );
    const workflowProfile = profileResolution.runtimeProfile;
    const executionContract = input.ExecutionContract;
    const executionEnabledByPolicy =
        executionContract !== undefined
            ? executionContract.response.responseMode === 'quality_grounded'
            : input.reviewLoopEnabled === true;
    // TODO(workflow-mode-escalation): Add explicit mode-transition handling
    // here if runtime mode escalation is introduced later. Current downstream
    // fallback behavior does not revise the initial mode decision.
    const workflowExecutionEnabled =
        modeDecision.behavior.workflowExecution === 'disabled'
            ? false
            : modeDecision.behavior.workflowExecution === 'always'
              ? true
              : workflowProfile.requiredHooks.forceWorkflowExecution ||
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
        maxWorkflowSteps: Math.min(
            sanitizePositiveInteger(
                executionContract?.limits.maxWorkflowSteps ??
                    (workflowProfile.policy.enableAssessment === false
                        ? 1
                        : input.maxIterations * 2),
                fallbackWorkflowStepLimit
            ),
            modeDecision.behavior.maxWorkflowSteps
        ),
        maxToolCalls: sanitizeNonNegativeInteger(
            executionContract?.limits.maxToolCalls ??
                workflowProfile.defaultLimits.maxToolCalls,
            workflowProfile.defaultLimits.maxToolCalls
        ),
        maxDeliberationCalls: Math.min(
            sanitizeNonNegativeInteger(
                executionContract?.limits.maxDeliberationCalls ??
                    (workflowProfile.policy.enableAssessment === false
                        ? 0
                        : input.maxIterations * 2),
                workflowProfile.defaultLimits.maxDeliberationCalls
            ),
            modeDecision.behavior.maxDeliberationCalls
        ),
        maxTokensTotal: sanitizeNonNegativeInteger(
            executionContract?.limits.maxTokensTotal ??
                workflowProfile.defaultLimits.maxTokensTotal,
            workflowProfile.defaultLimits.maxTokensTotal
        ),
        maxDurationMs: sanitizePositiveInteger(
            executionContract?.limits.maxDurationMs ?? input.maxDurationMs,
            workflowProfile.defaultLimits.maxDurationMs
        ),
    };

    return {
        requestedModeId:
            normalizeRequestedModeId(input.modeId) ?? DEFAULT_WORKFLOW_MODE_ID,
        modeId: modeDecision.modeId,
        modeDecision,
        profileId: workflowProfile.profileId,
        runtimeProfile: workflowProfile,
        profileContract: profileResolution.profileContract,
        workflowExecutionEnabled,
        workflowExecutionLimits,
    };
};
