/**
 * @description: Defines the canonical Execution Policy Contract (EPC) surface
 * for backend execution posture, evidence posture, and fail-open behavior.
 * @footnote-scope: interface
 * @footnote-module: ExecutionPolicyContract
 * @footnote-risk: medium - Contract drift here can fragment policy ownership and produce inconsistent execution behavior.
 * @footnote-ethics: high - EPC shapes whether users get quick direct output or bounded grounded output, which impacts trust and operator accountability.
 */

/**
 * EPC schema version. Keep this explicit so future breaking changes are easy to
 * identify in reviews and logs.
 */
export type ExecutionPolicyContractVersion = 'v1';

/**
 * Stable policy identifier.
 *
 * Built-in ids stay literal for autocomplete. String extension leaves room for
 * new ids before a registry is introduced.
 */
export type ExecutionPolicyContractId =
    | 'core-fast-direct'
    | 'core-quality-grounded'
    | (string & {});

/**
 * High-level execution posture.
 *
 * `fast_direct` favors low-latency one-pass answers.
 * `quality_grounded` favors bounded evidence-seeking before answering.
 */
export type ExecutionResponsePosture = 'fast_direct' | 'quality_grounded';

/**
 * Stopping intent for one execution loop.
 *
 * This keeps stop behavior policy-focused instead of tying it directly to step
 * toggles or implementation details.
 */
export type ExecutionStoppingIntent =
    | 'first_sufficient_answer'
    | 'bounded_grounded_answer';

/**
 * Top-level posture that explains "what kind of answer path are we aiming for".
 */
export type ExecutionPosture = {
    responsePosture: ExecutionResponsePosture;
    stoppingIntent: ExecutionStoppingIntent;
};

/**
 * Evidence acquisition expectations for one execution loop.
 *
 * This is intentionally bounded and transport-neutral. It describes how far
 * execution may go to gather support, not how adapters fetch data.
 */
export type ExecutionEvidencePolicy = {
    acquisitionMode: 'minimal' | 'bounded';
    escalationTrigger: 'on_low_confidence' | 'on_missing_required_context';
    requiredEvidenceLevel: 'none' | 'helpful' | 'grounded';
    mustTrackProvenance: boolean;
};

/**
 * Verification expectations before returning an answer.
 *
 * `none` keeps latency low. `light` runs a quick internal quality pass.
 * `grounded` expects evidence-aware checks before completion.
 */
export type ExecutionVerificationPolicy = {
    mode: 'none' | 'light' | 'grounded';
    requireConsistencyCheck: boolean;
    requireEvidenceBackedClaims: boolean;
};

/**
 * Quantitative hard limits for one execution loop.
 */
export type ExecutionPolicyLimits = {
    maxWorkflowSteps: number;
    maxToolCalls: number;
    maxDeliberationCalls: number;
    maxTokensTotal: number;
    maxDurationMs: number;
};

/**
 * Fail-open behavior remains backend-owned and explicit.
 *
 * EPC carries policy intent only. Incident response and operator controls stay
 * outside this contract.
 */
export type ExecutionPolicyFailOpen = {
    authority: 'backend';
    allowFallbackGeneration: boolean;
    fallbackTemperature: 'deterministic';
};

/**
 * Lightweight routing intent that policy can declare.
 *
 * This is provider-neutral. Model/provider selection logic stays outside EPC.
 */
export type ExecutionPolicyRoutingIntent = {
    strategy: 'capability-first' | 'profile-first';
    capabilityTags: string[];
};

/**
 * TrustGraph integration seam metadata.
 *
 * TrustGraph remains evidence/provenance input. It is not a second policy
 * authority and cannot block execution through this field.
 */
export type ExecutionPolicyTrustGraphSeam = {
    evidenceMode: 'off' | 'advisory';
    canBlockExecution: false;
};

/**
 * Canonical internal Execution Policy Contract.
 *
 * EPC is the main execution-policy object for runtime decisions. Presets are
 * named defaults over this contract, not separate contract shapes.
 */
export type ExecutionPolicyContract = {
    policyId: ExecutionPolicyContractId;
    policyVersion: ExecutionPolicyContractVersion;
    displayName: string;
    posture: ExecutionPosture;
    evidence: ExecutionEvidencePolicy;
    verification: ExecutionVerificationPolicy;
    limits: ExecutionPolicyLimits;
    failOpen: ExecutionPolicyFailOpen;
    routing: ExecutionPolicyRoutingIntent;
    trustGraph: ExecutionPolicyTrustGraphSeam;
    metadata?: Record<string, string | number | boolean | null>;
};

/**
 * Preset ids for reusable EPC defaults.
 *
 * A preset is not EPC itself. It is a named override set applied by the
 * builder to make policy intent easy to read and review.
 */
export type ExecutionPolicyPresetId =
    | 'fast-direct'
    | 'quality-grounded'
    | (string & {});

/**
 * Named overrides that can be applied while building an EPC.
 */
export type ExecutionPolicyPreset = {
    presetId: ExecutionPolicyPresetId;
    displayName: string;
    overrides: Partial<
        Omit<
            ExecutionPolicyContract,
            'policyId' | 'policyVersion' | 'displayName'
        >
    >;
};

/**
 * Builder input for creating one EPC instance.
 */
export type ExecutionPolicyContractBuilderInput = {
    policyId: ExecutionPolicyContractId;
    displayName: string;
    preset?: ExecutionPolicyPreset;
    overrides?: Partial<
        Omit<
            ExecutionPolicyContract,
            'policyId' | 'policyVersion' | 'displayName'
        >
    >;
};

/**
 * Standard defaults for EPC creation.
 *
 * Defaults favor a fast direct posture so callers must opt into heavier bounded
 * grounding expectations explicitly.
 */
const EPC_DEFAULTS: Omit<
    ExecutionPolicyContract,
    'policyId' | 'policyVersion' | 'displayName'
> = {
    posture: {
        responsePosture: 'fast_direct',
        stoppingIntent: 'first_sufficient_answer',
    },
    evidence: {
        acquisitionMode: 'minimal',
        escalationTrigger: 'on_low_confidence',
        requiredEvidenceLevel: 'helpful',
        mustTrackProvenance: true,
    },
    verification: {
        mode: 'light',
        requireConsistencyCheck: true,
        requireEvidenceBackedClaims: false,
    },
    limits: {
        maxWorkflowSteps: 4,
        maxToolCalls: 1,
        maxDeliberationCalls: 1,
        maxTokensTotal: 8_000,
        maxDurationMs: 25_000,
    },
    failOpen: {
        authority: 'backend',
        allowFallbackGeneration: true,
        fallbackTemperature: 'deterministic',
    },
    routing: {
        strategy: 'capability-first',
        capabilityTags: [],
    },
    trustGraph: {
        evidenceMode: 'advisory',
        canBlockExecution: false,
    },
};

/**
 * Canonical, reusable postures over EPC.
 */
export const EXECUTION_POLICY_PRESETS: Readonly<
    Record<'fast-direct' | 'quality-grounded', ExecutionPolicyPreset>
> = {
    'fast-direct': {
        presetId: 'fast-direct',
        displayName: 'Core Fast Direct',
        overrides: {
            posture: {
                responsePosture: 'fast_direct',
                stoppingIntent: 'first_sufficient_answer',
            },
            evidence: {
                acquisitionMode: 'minimal',
                escalationTrigger: 'on_low_confidence',
                requiredEvidenceLevel: 'none',
                mustTrackProvenance: true,
            },
            verification: {
                mode: 'none',
                requireConsistencyCheck: false,
                requireEvidenceBackedClaims: false,
            },
            limits: {
                maxWorkflowSteps: 3,
                maxToolCalls: 0,
                maxDeliberationCalls: 0,
                maxTokensTotal: 6_000,
                maxDurationMs: 18_000,
            },
            routing: {
                strategy: 'profile-first',
                capabilityTags: [],
            },
        },
    },
    'quality-grounded': {
        presetId: 'quality-grounded',
        displayName: 'Core Quality Grounded',
        overrides: {
            posture: {
                responsePosture: 'quality_grounded',
                stoppingIntent: 'bounded_grounded_answer',
            },
            evidence: {
                acquisitionMode: 'bounded',
                escalationTrigger: 'on_missing_required_context',
                requiredEvidenceLevel: 'grounded',
                mustTrackProvenance: true,
            },
            verification: {
                mode: 'grounded',
                requireConsistencyCheck: true,
                requireEvidenceBackedClaims: true,
            },
            limits: {
                maxWorkflowSteps: 8,
                maxToolCalls: 3,
                maxDeliberationCalls: 2,
                maxTokensTotal: 14_000,
                maxDurationMs: 70_000,
            },
            routing: {
                strategy: 'capability-first',
                capabilityTags: ['grounding', 'verification'],
            },
        },
    },
};

/**
 * Explicit list of concerns that stay outside EPC.
 *
 * Keep these boundaries visible so EPC does not become a mini framework.
 */
export const EXECUTION_POLICY_OUTSIDE_SCOPE: ReadonlyArray<string> = [
    'Transport-specific behavior (web/discord response shaping).',
    'TrustGraph evidence retrieval and ingestion implementation.',
    'Operator incident workflows and alerting channels.',
    'Provider-specific model invocation details.',
    'Prompt authoring and planner prompt wording.',
];

/**
 * Builder/factory entrypoint for one EPC instance.
 *
 * Merge order is defaults -> preset overrides -> explicit overrides so callers
 * can start from a posture preset and still tune fields for one policy id.
 */
export const buildExecutionPolicyContract = (
    input: ExecutionPolicyContractBuilderInput
): ExecutionPolicyContract => {
    const presetOverrides = input.preset?.overrides;
    const mergedMetadata = {
        ...(presetOverrides?.metadata ?? {}),
        ...(input.overrides?.metadata ?? {}),
    };

    const mergedPosture: ExecutionPosture = {
        ...EPC_DEFAULTS.posture,
        ...presetOverrides?.posture,
        ...input.overrides?.posture,
    };

    const mergedEvidence: ExecutionEvidencePolicy = {
        ...EPC_DEFAULTS.evidence,
        ...presetOverrides?.evidence,
        ...input.overrides?.evidence,
    };

    const mergedVerification: ExecutionVerificationPolicy = {
        ...EPC_DEFAULTS.verification,
        ...presetOverrides?.verification,
        ...input.overrides?.verification,
    };

    const mergedLimits: ExecutionPolicyLimits = {
        ...EPC_DEFAULTS.limits,
        ...presetOverrides?.limits,
        ...input.overrides?.limits,
    };

    const mergedFailOpen: ExecutionPolicyFailOpen = {
        ...EPC_DEFAULTS.failOpen,
        ...presetOverrides?.failOpen,
        ...input.overrides?.failOpen,
        authority: 'backend',
        fallbackTemperature: 'deterministic',
    };

    const mergedRouting: ExecutionPolicyRoutingIntent = {
        ...EPC_DEFAULTS.routing,
        ...presetOverrides?.routing,
        ...input.overrides?.routing,
    };

    const mergedTrustGraph: ExecutionPolicyTrustGraphSeam = {
        ...EPC_DEFAULTS.trustGraph,
        ...presetOverrides?.trustGraph,
        ...input.overrides?.trustGraph,
        canBlockExecution: false,
    };

    return {
        policyId: input.policyId,
        policyVersion: 'v1',
        displayName: input.displayName,
        posture: mergedPosture,
        evidence: mergedEvidence,
        verification: mergedVerification,
        limits: mergedLimits,
        failOpen: mergedFailOpen,
        routing: mergedRouting,
        trustGraph: mergedTrustGraph,
        metadata:
            Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
    };
};
