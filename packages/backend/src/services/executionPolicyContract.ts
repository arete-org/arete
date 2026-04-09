/**
 * @description: Defines the canonical Execution Policy Contract (EPC) surface
 * for backend response intent, evidence sufficiency policy, and fail-open behavior.
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
 * High-level response mode.
 *
 * `fast_direct` favors low-latency one-pass answers.
 * `quality_grounded` favors bounded sufficiency-seeking before answering.
 */
export type ExecutionResponseMode = 'fast_direct' | 'quality_grounded';

/**
 * Stopping rule for one execution loop.
 *
 * This keeps stop behavior policy-focused instead of tying it directly to step
 * toggles or implementation details.
 */
export type ExecutionStoppingRule =
    | 'first_sufficient_answer'
    | 'bounded_sufficient_answer';

/**
 * Top-level response intent that explains "what kind of answer path are we aiming for".
 */
export type ExecutionResponseIntent = {
    responseMode: ExecutionResponseMode;
    stoppingRule: ExecutionStoppingRule;
};

/**
 * Evidence acquisition and sufficiency expectations for one execution loop.
 *
 * This is intentionally bounded and transport-neutral. It describes how far
 * execution may go to gather support, not how adapters fetch data.
 */
export type EvidenceEscalationTrigger =
    | 'missing_required_context' // Required facts are absent from current context/evidence set.
    | 'sufficiency_not_met_within_current_evidence'; // Current evidence exists but does not satisfy policy sufficiency target.

export type RequiredEvidenceLevel =
    | 'none' // No external evidence is required; inference-only answer is allowed.
    | 'context_support' // Supporting context/evidence is expected, but strict claim-level grounding is not required.
    | 'grounded_support'; // Answer claims should be traceable to bounded supporting evidence.

export type EvidenceSufficiencyTarget =
    | 'answer_is_directionally_useful' // Prioritize useful answer direction quickly, with minimal evidence acquisition.
    | 'answer_is_grounded_and_actionable'; // Prioritize grounded answer quality that is actionable within bounded search.

export type ExecutionEvidencePolicy = {
    acquisitionMode: 'minimal' | 'bounded';
    escalationTrigger: EvidenceEscalationTrigger;
    requiredEvidenceLevel: RequiredEvidenceLevel;
    sufficiencyTarget: EvidenceSufficiencyTarget;
    maxEscalationRounds: number;
    mustTrackProvenance: boolean;
};

/**
 * Verification expectations before returning an answer.
 *
 * `none` keeps latency low.
 * `coherence_check` validates answer consistency only.
 * `grounded_sufficiency_check` validates consistency plus evidence sufficiency.
 */
export type ExecutionVerificationPolicy = {
    mode: VerificationMode;
    requireConsistencyCheck: boolean;
    requireEvidenceBackedClaims: boolean;
};

export type VerificationMode =
    | 'none' // Return without verification pass beyond normal generation.
    | 'coherence_check' // Validate internal coherence/consistency only.
    | 'grounded_sufficiency_check'; // Validate coherence plus bounded evidence sufficiency expectations.

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
 * Lightweight routing intent seam that policy can declare.
 *
 * This is provider-neutral. Model/provider selection logic stays outside EPC.
 * This is not a full multi-search or evidence-acquisition strategy layer.
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
    response: ExecutionResponseIntent;
    evidence: ExecutionEvidencePolicy;
    verification: ExecutionVerificationPolicy;
    limits: ExecutionPolicyLimits;
    failOpen: ExecutionPolicyFailOpen;
    routing: ExecutionPolicyRoutingIntent;
    trustGraph: ExecutionPolicyTrustGraphSeam;
    /**
     * Optional diagnostics metadata only.
     *
     * Do not store core policy semantics here. Add first-class fields instead.
     */
    metadata?: Record<string, string | number | boolean | null>;
};

/**
 * Preset ids for reusable EPC defaults.
 *
 * A preset is not EPC itself. It is a named override set applied by the
 * builder to make policy intent easy to read and review.
 * Preset ids use kebab-case (`fast-direct`), while `response.responseMode`
 * uses snake_case (`fast_direct`) for execution intent vocabulary.
 */
export type ExecutionPolicyPresetId =
    | 'fast-direct'
    | 'quality-grounded'
    | (string & {});

/**
 * Shared override shape used by EPC presets, builders, and resolver assembly.
 */
export type ExecutionPolicyContractOverrides = Partial<
    Omit<ExecutionPolicyContract, 'policyId' | 'policyVersion' | 'displayName'>
>;

/**
 * Named overrides that can be applied while building an EPC.
 */
export type ExecutionPolicyPreset = {
    presetId: ExecutionPolicyPresetId;
    displayName: string;
    overrides: ExecutionPolicyContractOverrides;
};

/**
 * Builder input for creating one EPC instance.
 */
export type ExecutionPolicyContractBuilderInput = {
    policyId: ExecutionPolicyContractId;
    displayName: string;
    preset?: ExecutionPolicyPreset;
    overrides?: ExecutionPolicyContractOverrides;
};

/**
 * Standard defaults for EPC creation.
 *
 * Defaults favor a fast direct response path so callers must opt into heavier bounded
 * grounding expectations explicitly.
 */
const EPC_DEFAULTS: Omit<
    ExecutionPolicyContract,
    'policyId' | 'policyVersion' | 'displayName'
> = {
    response: {
        responseMode: 'fast_direct',
        stoppingRule: 'first_sufficient_answer',
    },
    evidence: {
        acquisitionMode: 'minimal',
        escalationTrigger: 'missing_required_context',
        requiredEvidenceLevel: 'context_support',
        sufficiencyTarget: 'answer_is_directionally_useful',
        maxEscalationRounds: 1,
        mustTrackProvenance: true,
    },
    verification: {
        mode: 'coherence_check',
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
 * Canonical, reusable response presets over EPC.
 *
 * Practical difference:
 * `fast-direct` is latency-first.
 * `quality-grounded` is bounded evidence-first.
 */
export const EXECUTION_POLICY_PRESETS: Readonly<
    Record<'fast-direct' | 'quality-grounded', ExecutionPolicyPreset>
> = {
    'fast-direct': {
        presetId: 'fast-direct',
        displayName: 'Core Fast Direct',
        overrides: {
            response: {
                responseMode: 'fast_direct',
                stoppingRule: 'first_sufficient_answer',
            },
            evidence: {
                acquisitionMode: 'minimal',
                escalationTrigger: 'missing_required_context',
                requiredEvidenceLevel: 'none',
                sufficiencyTarget: 'answer_is_directionally_useful',
                maxEscalationRounds: 0,
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
            response: {
                responseMode: 'quality_grounded',
                stoppingRule: 'bounded_sufficient_answer',
            },
            evidence: {
                acquisitionMode: 'bounded',
                escalationTrigger:
                    'sufficiency_not_met_within_current_evidence',
                requiredEvidenceLevel: 'grounded_support',
                sufficiencyTarget: 'answer_is_grounded_and_actionable',
                maxEscalationRounds: 2,
                mustTrackProvenance: true,
            },
            verification: {
                mode: 'grounded_sufficiency_check',
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
    'Multi-search/evidence acquisition implementation strategy.',
    'Prompt authoring and planner prompt wording.',
];

/**
 * Returns a safe numeric value for policy fields that must be finite and non-negative.
 */
const sanitizeNonNegativeFiniteNumber = (
    value: number,
    fallback: number
): number => (Number.isFinite(value) && value >= 0 ? value : fallback);

/**
 * Builder/factory entrypoint for one EPC instance.
 *
 * Merge order is defaults -> preset overrides -> explicit overrides so callers
 * can start from a response preset and still tune fields for one policy id.
 */
export const buildExecutionPolicyContract = (
    input: ExecutionPolicyContractBuilderInput
): ExecutionPolicyContract => {
    const presetOverrides = input.preset?.overrides;
    const mergedMetadata = {
        ...(presetOverrides?.metadata ?? {}),
        ...(input.overrides?.metadata ?? {}),
    };

    const mergedResponse: ExecutionResponseIntent = {
        ...EPC_DEFAULTS.response,
        ...presetOverrides?.response,
        ...input.overrides?.response,
    };

    const mergedEvidence: ExecutionEvidencePolicy = {
        ...EPC_DEFAULTS.evidence,
        ...presetOverrides?.evidence,
        ...input.overrides?.evidence,
        maxEscalationRounds: sanitizeNonNegativeFiniteNumber(
            input.overrides?.evidence?.maxEscalationRounds ??
                presetOverrides?.evidence?.maxEscalationRounds ??
                EPC_DEFAULTS.evidence.maxEscalationRounds,
            EPC_DEFAULTS.evidence.maxEscalationRounds
        ),
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
        maxWorkflowSteps: sanitizeNonNegativeFiniteNumber(
            input.overrides?.limits?.maxWorkflowSteps ??
                presetOverrides?.limits?.maxWorkflowSteps ??
                EPC_DEFAULTS.limits.maxWorkflowSteps,
            EPC_DEFAULTS.limits.maxWorkflowSteps
        ),
        maxToolCalls: sanitizeNonNegativeFiniteNumber(
            input.overrides?.limits?.maxToolCalls ??
                presetOverrides?.limits?.maxToolCalls ??
                EPC_DEFAULTS.limits.maxToolCalls,
            EPC_DEFAULTS.limits.maxToolCalls
        ),
        maxDeliberationCalls: sanitizeNonNegativeFiniteNumber(
            input.overrides?.limits?.maxDeliberationCalls ??
                presetOverrides?.limits?.maxDeliberationCalls ??
                EPC_DEFAULTS.limits.maxDeliberationCalls,
            EPC_DEFAULTS.limits.maxDeliberationCalls
        ),
        maxTokensTotal: sanitizeNonNegativeFiniteNumber(
            input.overrides?.limits?.maxTokensTotal ??
                presetOverrides?.limits?.maxTokensTotal ??
                EPC_DEFAULTS.limits.maxTokensTotal,
            EPC_DEFAULTS.limits.maxTokensTotal
        ),
        maxDurationMs: sanitizeNonNegativeFiniteNumber(
            input.overrides?.limits?.maxDurationMs ??
                presetOverrides?.limits?.maxDurationMs ??
                EPC_DEFAULTS.limits.maxDurationMs,
            EPC_DEFAULTS.limits.maxDurationMs
        ),
    };

    const mergedFailOpen: ExecutionPolicyFailOpen = {
        ...EPC_DEFAULTS.failOpen,
        ...presetOverrides?.failOpen,
        ...input.overrides?.failOpen,
        authority: 'backend',
        fallbackTemperature: 'deterministic',
    };

    const resolvedCapabilityTags: string[] =
        input.overrides?.routing?.capabilityTags ??
        presetOverrides?.routing?.capabilityTags ??
        EPC_DEFAULTS.routing.capabilityTags;

    const mergedRouting: ExecutionPolicyRoutingIntent = {
        ...EPC_DEFAULTS.routing,
        ...presetOverrides?.routing,
        ...input.overrides?.routing,
        capabilityTags: [...resolvedCapabilityTags],
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
        response: mergedResponse,
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
