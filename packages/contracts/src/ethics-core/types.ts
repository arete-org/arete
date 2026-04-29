/**
 * @description: Shared type contracts for response provenance, safety, and metadata.
 * @footnote-scope: interface
 * @footnote-module: EthicsCoreContracts
 * @footnote-risk: low - Incorrect shapes can break UI assumptions or validation.
 * @footnote-ethics: medium - Types document data meaning but do not execute logic.
 */

// This file is the single source of truth for cross-package metadata shapes.
// It is intentionally "types only": no functions and no runtime behavior.

/**
 * SafetyTier labels how sensitive a response is.
 * The UI uses this to choose colors and display warnings.
 */
export type SafetyTier = 'Low' | 'Medium' | 'High';

/**
 * Stable deterministic rule IDs emitted by the backend risk evaluator.
 * Values are versioned so future rule changes can roll forward safely.
 */
export type SafetyRuleId =
    | 'safety.self_harm.crisis_intent.v1'
    | 'safety.weaponization_request.v1'
    | 'safety.professional.medical_or_legal_advice.v1';

/**
 * Provenance describes where the answer "came from" at a high level.
 *
 * This is a backend classification label. It is deterministic for a given
 * signal set, but signal availability is still evolving, so callers should
 * treat this as a compact summary rather than raw execution truth.
 */
export type Provenance = 'Retrieved' | 'Inferred' | 'Speculative';

/**
 * Deterministic signal map used by provenance evaluators.
 * This shape stays serializable for logging and trace debugging.
 */
export type ProvenanceSignals = {
    retrieval: boolean;
    speculation: boolean;
    hasContext: boolean;
};

/**
 * A citation points to a source used in a response.
 */
export type Citation = {
    title: string;
    url: string;
    snippet?: string;
};

/**
 * ProvenanceAssessment records how a provenance label was chosen.
 * This is deterministic, serializable, and intended for trace inspection.
 */
export type ProvenanceAssessment = {
    methodId: 'deterministic_multi_signal_v1';
    methodLabel: string;
    signals: {
        citationsPresent: boolean;
        retrievalRequested: boolean;
        retrievalUsed: boolean;
        retrievalToolExecuted: boolean;
        workflowEvidence: boolean;
        trustGraphEvidenceAvailable: boolean;
        trustGraphEvidenceUsed: boolean;
        assistantDeclaredSpeculative: boolean;
    };
    conflicts: string[];
    limitations: string[];
};

/**
 * TraceAxisScore is a single TRACE axis value on a 1..5 scale.
 * TypeScript enforces this range for typed literals.
 */
export type TraceAxisScore = 1 | 2 | 3 | 4 | 5;

/**
 * ResponseTemperament captures TRACE (response temperament) as five normalized
 * integer axes:
 * T = tightness, R = rationale, A = attribution, C = caution, E = extent.
 *
 * Scale: each axis is an integer from 1 to 5.
 * Runtime payloads still require schema validation.
 */
export type ResponseTemperament = {
    tightness: TraceAxisScore; // 1 to 5: concision and structural efficiency.
    rationale: TraceAxisScore; // 1 to 5: amount of visible rationale and trade-off explanation.
    attribution: TraceAxisScore; // 1 to 5: clarity of sourced vs inferred boundaries.
    caution: TraceAxisScore; // 1 to 5: safeguard posture and overclaim restraint.
    extent: TraceAxisScore; // 1 to 5: breadth of viable options and perspectives.
};

/**
 * PartialResponseTemperament allows missing TRACE axes.
 * Missing values are interpreted by renderers as unavailable.
 *
 * TRACE is answer-posture metadata, not source-grounding metadata. Do not
 * treat this as a provenance substitute.
 */
export type PartialResponseTemperament = Partial<ResponseTemperament>;

/**
 * Reason code for cases where delivered TRACE posture differs from the
 * intended TRACE posture.
 *
 * Keep this narrow in v1. Additive expansion is allowed when runtime
 * divergence classes become contract-stable.
 */
export type TraceFinalizationReasonCode = 'runtime_posture_adjustment';

export type ExecutionStatus = 'executed' | 'skipped' | 'failed';

/**
 * Stable execution reason codes emitted by backend orchestration/runtime.
 * Keep this list narrow so logs/UI/tests can rely on deterministic values.
 */
export type ExecutionReasonCode =
    | 'planner_runtime_error'
    | 'planner_invalid_output'
    | 'evaluator_runtime_error'
    | 'generation_runtime_error'
    | 'tool_not_requested'
    | 'tool_not_used'
    | 'search_rerouted_to_fallback_profile'
    | 'search_reroute_not_permitted_by_selection_source'
    | 'search_reroute_no_tool_capable_fallback_available'
    | 'tool_unavailable'
    | 'tool_execution_error'
    | 'tool_timeout'
    | 'tool_http_error'
    | 'tool_network_error'
    | 'tool_invalid_response'
    | 'location_not_resolved'
    | 'search_not_supported_by_selected_profile'
    | 'unspecified_tool_outcome';

export type PlannerExecutionReasonCode = Extract<
    ExecutionReasonCode,
    'planner_runtime_error' | 'planner_invalid_output'
>;

/**
 * Canonical planner invocation purpose labels.
 * Keep additive and serializable for trace auditability.
 * Purpose labels describe bounded planner intent, not policy ownership.
 */
export type PlannerExecutionPurpose = 'chat_orchestrator_action_selection';

/**
 * Planner contract execution style used for this invocation.
 */
export type PlannerExecutionContractType =
    | 'structured'
    | 'text_json'
    | 'fallback';

/**
 * How planner output was applied by workflow-owned policy/routing.
 * This records execution effect, not planner authority.
 */
export type PlannerExecutionApplyOutcome =
    | 'applied'
    | 'adjusted_by_policy'
    | 'not_applied';

export type EvaluatorExecutionReasonCode = Extract<
    ExecutionReasonCode,
    'evaluator_runtime_error'
>;

export type GenerationExecutionReasonCode = Extract<
    ExecutionReasonCode,
    'generation_runtime_error'
>;

export type EvaluatorAuthorityLevel = 'observe' | 'influence' | 'enforce';

export type EvaluatorDecisionMode = 'observe_only' | 'enforced';

export type SafetyAction =
    | 'allow'
    | 'block'
    | 'redirect'
    | 'safe_partial'
    | 'human_review';

export type SafetyReasonCode =
    | 'self_harm_crisis_intent'
    | 'weaponization_request'
    | 'professional_advice_guardrail';

/**
 * V1 keeps evaluator input intentionally narrow.
 * TODO(v2-safety-rules): Add trigger/surface/attachment/correlation fields
 * once deterministic rules consume them.
 */
export type SafetyEvaluationInput = {
    latestUserInput: string;
    conversation: Array<{
        role: 'system' | 'user' | 'assistant';
        content: string;
    }>;
};

type SafetyEvaluationMetadata = Record<
    string,
    string | number | boolean | null | string[]
>;

export type SafetyEvaluationResult =
    | {
          action: 'allow';
          safetyTier: SafetyTier;
          ruleId: null;
          matchedRuleIds: SafetyRuleId[];
          reasonCode?: never;
          reason?: never;
          metadata?: SafetyEvaluationMetadata;
      }
    | {
          action: Exclude<SafetyAction, 'allow'>;
          safetyTier: SafetyTier;
          ruleId: SafetyRuleId;
          matchedRuleIds: SafetyRuleId[];
          reasonCode: SafetyReasonCode;
          reason: string;
          metadata?: SafetyEvaluationMetadata;
      };

export type SafetyDecision =
    | {
          action: 'allow';
          safetyTier: SafetyTier;
          ruleId: null;
      }
    | {
          action: Exclude<SafetyAction, 'allow'>;
          safetyTier: SafetyTier;
          ruleId: SafetyRuleId;
          reasonCode: SafetyReasonCode;
          reason: string;
      };

/**
 * Deterministic evaluator outcome emitted during orchestration.
 * This stays additive and non-blocking while strict breaker enforcement rolls
 * out incrementally.
 */
export type EvaluatorOutcome = {
    /**
     * Optional for legacy trace compatibility at ingestion boundaries.
     * New runtime writes should always include this field.
     */
    authorityLevel?: EvaluatorAuthorityLevel;
    /**
     * @deprecated Use authorityLevel instead.
     * Kept as a transitional mirror for legacy consumers.
     */
    mode: EvaluatorDecisionMode;
    provenance: Provenance;
    safetyDecision: SafetyDecision;
};

/**
 * Stable tool names emitted in planner/runtime execution records.
 * Keep this string union narrow and additive so clients can pattern-match
 * known tools while still allowing forward-compatible unknown values.
 */
export type ToolInvocationName =
    | 'web_search'
    | 'weather_forecast'
    | (string & {});

export type WeatherToolInputLocation =
    | {
          type: 'lat_lon';
          latitude: number;
          longitude: number;
      }
    | {
          type: 'place_query';
          query: string;
          countryCode?: string;
      };

export type WeatherToolInput = {
    location: WeatherToolInputLocation;
    horizonPeriods?: number;
};

/**
 * Tool reason codes used across eligibility and execution records.
 * Includes skip/failure outcomes plus executed policy reroute metadata.
 */
export type ToolInvocationReasonCode = Extract<
    ExecutionReasonCode,
    | 'tool_not_requested'
    | 'tool_not_used'
    | 'tool_unavailable'
    | 'tool_execution_error'
    | 'tool_timeout'
    | 'tool_http_error'
    | 'tool_network_error'
    | 'tool_invalid_response'
    | 'search_rerouted_to_fallback_profile'
    | 'search_reroute_not_permitted_by_selection_source'
    | 'search_reroute_no_tool_capable_fallback_available'
    | 'search_not_supported_by_selected_profile'
    | 'unspecified_tool_outcome'
>;

export type ExecutionEventKind =
    | 'planner'
    | 'evaluator'
    | 'tool'
    | 'generation';

type BaseExecutionEvent = {
    status: ExecutionStatus;
    durationMs?: number;
};

type ProfileExecutionEvent = BaseExecutionEvent & {
    originalProfileId?: string;
    effectiveProfileId?: string;
    profileId?: string;
    provider?: string;
    model?: string;
};

export type PlannerExecutionEvent = ProfileExecutionEvent & {
    kind: 'planner';
    // Deprecated in runtime emission. Planner lineage is represented by
    // workflow `steps[]` with `stepKind=plan`.
    purpose: PlannerExecutionPurpose;
    contractType: PlannerExecutionContractType;
    applyOutcome: PlannerExecutionApplyOutcome;
    mattered: boolean;
    matteredControlIds: SteerabilityControlId[];
    reasonCode?: PlannerExecutionReasonCode;
};

export type EvaluatorExecutionEvent = BaseExecutionEvent & {
    kind: 'evaluator';
    evaluator?: EvaluatorOutcome;
    reasonCode?: EvaluatorExecutionReasonCode;
};

export type ToolExecutionEvent = BaseExecutionEvent & {
    kind: 'tool';
    toolName: string;
    reasonCode?: ToolInvocationReasonCode;
};

export type GenerationExecutionEvent = ProfileExecutionEvent & {
    kind: 'generation';
    reasonCode?: GenerationExecutionReasonCode;
};

export const WORKFLOW_STEP_STATUSES = [
    'executed',
    'skipped',
    'failed',
] as const;

export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];

export const WORKFLOW_STEP_KINDS = [
    'plan',
    'tool',
    'generate',
    'assess',
    'revise',
    'finalize',
] as const;

export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

export const WORKFLOW_TERMINATION_REASONS = [
    'goal_satisfied',
    'budget_exhausted_steps',
    'budget_exhausted_tokens',
    'budget_exhausted_time',
    'transition_blocked_by_policy',
    'max_tool_calls_reached',
    'max_deliberation_calls_reached',
    'executor_error_fail_open',
] as const;

export type WorkflowTerminationReason =
    (typeof WORKFLOW_TERMINATION_REASONS)[number];

export const WORKFLOW_LIMIT_KEYS = [
    'maxWorkflowSteps',
    'maxToolCalls',
    'maxDeliberationCalls',
    'maxTokensTotal',
    'maxDurationMs',
] as const;

export type WorkflowLimitKey = (typeof WORKFLOW_LIMIT_KEYS)[number];

export const WORKFLOW_LIMIT_STATES = [
    'enforced',
    'configured_inactive',
    'unavailable',
] as const;

export type WorkflowLimitState = (typeof WORKFLOW_LIMIT_STATES)[number];

export type WorkflowEffectiveLimit = {
    key: WorkflowLimitKey;
    state: WorkflowLimitState;
    value?: number;
    stoppedRun: boolean;
};

export type WorkflowLimitStop = {
    stoppedByLimit: boolean;
    terminationReason: WorkflowTerminationReason;
    exhaustedLimitKey?: WorkflowLimitKey;
};

/**
 * Canonical assess-step decisions emitted by bounded review profiles.
 * These are advisory outputs used by workflow transitions, not policy authority.
 */
export const BOUNDED_REVIEW_ASSESS_DECISIONS = ['finalize', 'revise'] as const;

export type BoundedReviewAssessDecision =
    (typeof BOUNDED_REVIEW_ASSESS_DECISIONS)[number];

/**
 * Canonical machine-readable assess output for bounded review profiles.
 *
 * Keep this intentionally narrow so review output remains inspectable and does
 * not become a generic policy bag.
 */
export type BoundedReviewAssessSignals = {
    reviewDecision: BoundedReviewAssessDecision;
    reviewReason: string;
};

export type StepOutcome = {
    status: WorkflowStepStatus;
    summary: string;
    artifacts?: string[];
    /**
     * Machine-readable per-step outputs.
     *
     * For `stepKind === "assess"` in the bounded-review profile, emit
     * `reviewDecision` + `reviewReason` as the canonical decision seam.
     */
    signals?: Record<string, string | number | boolean | null>;
    recommendations?: string[];
};

export type StepRecord = {
    stepId: string;
    parentStepId?: string;
    attempt: number;
    stepKind: WorkflowStepKind;
    reasonCode?: ExecutionReasonCode;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    model?: string;
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
    };
    cost?: {
        inputCostUsd: number;
        outputCostUsd: number;
        totalCostUsd: number;
    };
    outcome: StepOutcome;
};

export type WorkflowRecord = {
    workflowId: string;
    workflowName: string;
    status: 'completed' | 'degraded';
    terminationReason: WorkflowTerminationReason;
    stepCount: number;
    maxSteps: number;
    maxDurationMs: number;
    effectiveLimits?: WorkflowEffectiveLimit[];
    limitStop?: WorkflowLimitStop;
    steps: StepRecord[];
};

/**
 * Canonical high-level workflow mode ids.
 */
export type WorkflowModeId = 'fast' | 'balanced' | 'grounded';

export type WorkflowModeSelectionSource =
    | 'requested_mode'
    | 'inferred_from_execution_contract'
    | 'fail_open_default'
    | 'workflow_mode_escalation';

export type WorkflowModeEvidencePosture = 'minimal' | 'balanced' | 'strict';

export type WorkflowModeBehavior = {
    executionContractPresetId: 'fast-direct' | 'balanced' | 'quality-grounded';
    workflowProfileClass: 'direct' | 'reviewed';
    workflowProfileId: 'bounded-review' | 'generate-only';
    workflowExecution: 'disabled' | 'policy_gated' | 'always';
    reviewPass: 'included' | 'excluded';
    reviseStep: 'allowed' | 'disallowed';
    evidencePosture: WorkflowModeEvidencePosture;
    maxWorkflowSteps: number;
    maxDeliberationCalls: number;
};

export type WorkflowModeDecision = {
    modeId: WorkflowModeId;
    selectedBy: WorkflowModeSelectionSource;
    selectionReason: string;
    initial_mode: WorkflowModeId;
    escalated_mode?: WorkflowModeId;
    escalation_reason?: string;
    requestedModeId?: string;
    executionContractResponseMode?: 'fast_direct' | 'quality_grounded';
    behavior: WorkflowModeBehavior;
};

/**
 * Canonical review-runtime labels for UI rendering.
 * Labels describe execution path semantics only, not answer quality.
 */
export const REVIEW_RUNTIME_LABELS = [
    'not_reviewed',
    'reviewed_no_revision',
    'revised',
    'skipped',
    'fallback',
] as const;

export type ReviewRuntimeLabel = (typeof REVIEW_RUNTIME_LABELS)[number];

/**
 * Compact normalized review-runtime summary for UI surfaces.
 * This is backend-derived so UI does not infer semantics from raw steps.
 */
export type ReviewRuntimeSummary = {
    label: ReviewRuntimeLabel;
};

/**
 * Canonical steerability control ids tracked in response metadata.
 * These remain backend-owned/operator-facing until user controls are exposed.
 */
export type SteerabilityControlId =
    | 'workflow_mode'
    | 'evidence_strictness'
    | 'review_intensity'
    | 'provider_preference'
    | 'persona_tone_overlay'
    | 'tool_allowance';

export type SteerabilityControlSource =
    | 'runtime_config'
    | 'execution_contract'
    | 'request_override'
    | 'planner_output'
    | 'surface_profile'
    | 'capability_policy'
    | 'tool_policy'
    | 'fail_open_default';

export type SteerabilityImpactTarget =
    | 'workflow_execution'
    | 'execution_contract_selection'
    | 'review_loop_execution'
    | 'model_profile_selection'
    | 'persona_prompt_layer'
    | 'tool_eligibility';

export type SteerabilityControlRecord = {
    controlId: SteerabilityControlId;
    value: string;
    source: SteerabilityControlSource;
    rationale: string;
    mattered: boolean;
    impactedTargets: SteerabilityImpactTarget[];
};

export type SteerabilityControls = {
    version: 'v1';
    controls: SteerabilityControlRecord[];
};

/**
 * Shared correlation envelope for structured backend telemetry.
 * Fields are nullable so callers can keep fail-open behavior.
 */
export type CorrelationEnvelope = {
    conversationId: string | null;
    requestId: string | null;
    incidentId: string | null;
    responseId: string | null;
};

/**
 * Planner-owned tool intent before orchestration eligibility checks.
 * This shape is fully serializable for trace/debug payloads.
 */
export type ToolInvocationIntent = {
    toolName: ToolInvocationName;
    requested: boolean;
    input?: Record<string, unknown> | WeatherToolInput;
};

/**
 * Orchestrator-owned tool eligibility decision before runtime execution.
 * This is the pre-check: should we even try the tool?
 */
export type ToolInvocationRequest = {
    toolName: ToolInvocationName;
    requested: boolean;
    eligible: boolean;
    reasonCode?: ToolInvocationReasonCode;
};

/**
 * Runtime-owned final tool outcome emitted into execution metadata.
 * This is the outcome after that check: ran, skipped, or failed.
 */
export type ToolExecutionContext = {
    toolName: ToolInvocationName;
    status: ExecutionStatus;
    reasonCode?: ToolInvocationReasonCode;
    durationMs?: number;
};

/**
 * One backend-owned execution timeline entry for this response.
 *
 * This v1 shape is intentionally compact and is expected to grow once
 * workflow-based execution is enabled (lineage, timing, and per-step usage).
 */
export type ExecutionEvent =
    | PlannerExecutionEvent
    | EvaluatorExecutionEvent
    | ToolExecutionEvent
    | GenerationExecutionEvent;
export type TrustGraphProvenanceReasonCode =
    | 'external_scope_validation_failed'
    | 'adapter_scope_mismatch'
    | 'adapter_disabled'
    | 'adapter_timeout'
    | 'adapter_timeout_cancellation_requested'
    | 'adapter_error'
    | 'adapter_processing_failed'
    | 'poisoned_evidence_dropped'
    | 'aggregate_signals_neutralized_after_filtering'
    | 'ownership_validation_explicitly_none_denied'
    | 'ownership_validation_explicitly_none_allowed_non_production';

export type TrustGraphScopeValidationResult =
    | {
          ok: true;
          normalizedScope: {
              userId: string;
              projectId?: string;
              collectionId?: string;
          };
      }
    | {
          ok: false;
          reasonCode: 'external_scope_validation_failed';
          details: string;
      };

export type TrustGraphMetadata = {
    // This says what TrustGraph contributed to the response. It does not
    // replace the backend's own execution and policy records.
    adapterStatus: 'off' | 'scope_denied' | 'success' | 'timeout' | 'error';
    scopeValidation: TrustGraphScopeValidationResult;
    terminalAuthority: 'backend_execution_contract';
    failOpenBehavior: 'local_behavior';
    verificationRequired: true;
    advisoryEvidenceItemCount: number;
    droppedEvidenceCount: number;
    droppedEvidenceIds: string[];
    provenanceReasonCodes: TrustGraphProvenanceReasonCode[];
    sufficiencyView: {
        coverageValue?: number;
        coverageEvaluationUnit?: 'claim' | 'subquestion' | 'source';
        conflictSignals: string[];
    };
    evidenceView: {
        sourceRefs: string[];
        provenancePathRefs: string[];
        traceRefs: string[];
    };
    provenanceJoin?: {
        externalEvidenceBundleId: string;
        externalTraceRefs: string[];
        adapterVersion: string;
        consumedGovernedFieldPaths: string[];
        consumedByConsumers: Array<'P_SUFF' | 'P_EVID'>;
        droppedEvidenceIds: string[];
        reasonCodes: TrustGraphProvenanceReasonCode[];
    };
};

/**
 * Canonical image-generation trace payload attached to response metadata.
 *
 * TODO(auth-memory-governance): Gate prompt visibility/storage through the
 * upcoming user opt-in auth/memory/governance controls before broad exposure.
 */
export type ImageGenerationMetadata = {
    version: 'v1';
    prompts: {
        original: string;
        active: string;
        revised: string | null;
        maxInputChars: number;
        policyTruncated: boolean;
    };
    request: {
        textModel: string;
        imageModel: string;
        quality: 'low' | 'medium' | 'high' | 'auto';
        size: 'auto' | '1024x1024' | '1024x1536' | '1536x1024';
        aspectRatio: 'auto' | 'square' | 'portrait' | 'landscape';
        background: 'auto' | 'transparent' | 'opaque';
        style: string;
        allowPromptAdjustment: boolean;
        outputFormat: 'png' | 'webp' | 'jpeg';
        outputCompression: number;
    };
    linkage: {
        followUpResponseId: string | null;
    };
    result: {
        outputResponseId: string | null;
        finalStyle: string;
        generationTimeMs: number;
    };
    usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        imageCount: number;
    };
    costs: {
        text: number;
        image: number;
        total: number;
        perImage: number;
    };
};

/**
 * ResponseMetadata is the compact record attached to a model response.
 *
 * Not every field means the same thing. Some values are direct runtime facts,
 * some are best-effort summaries, and a few are only here to keep older
 * consumers working while newer fields roll out.
 */
export type ResponseMetadata = {
    // TODO(metadata-stability-tiers): Publish explicit stability tiers
    // (structural, heuristic, transitional) in one machine-readable contract
    // so consumers do not infer truth guarantees from optionality alone.
    responseId: string; // Short id for trace lookups and links.
    provenance: Provenance; // Compact grounding classification for the response.
    safetyTier: SafetyTier; // Sensitivity level used by UI and reviewers.
    tradeoffCount: number; // Heuristic-friendly summary count from assistant metadata with planner fallback.
    chainHash: string; // Short hash to help detect tampering.
    licenseContext: string; // Human-readable license label.
    /** @deprecated Prefer execution[] as the canonical model/runtime timeline. */
    // TODO(metadata-compat-model-version): Remove after downstream consumers
    // migrate to execution[] generation events as their model authority.
    modelVersion: string; // Compatibility mirror of the final generation model.
    staleAfter: string; // ISO timestamp after which the data is stale.
    totalDurationMs?: number; // End-to-end orchestration duration when available.
    citations: Citation[]; // Sources used for the answer.
    provenanceAssessment?: ProvenanceAssessment; // Classification-method disclosure for provenance, including conflicts and limitations.
    execution?: ExecutionEvent[]; // Structural execution record (evaluator/tool/generation events).
    workflow?: WorkflowRecord; // Optional workflow record of bounded multi-step execution; includes planner lineage via plan steps.
    reviewRuntime?: ReviewRuntimeSummary; // Normalized review-runtime summary for UI labels (path semantics only).
    workflowMode?: WorkflowModeDecision; // Execution-policy routing decision and behavior mapping.
    steerabilityControls?: SteerabilityControls; // Control-influence records explaining which controls shaped execution/output.
    evaluator?: EvaluatorOutcome; // Deterministic evaluator decision captured before breaker enforcement.
    imageDescriptions?: string[]; // Optional captions for any images used.
    evidenceScore?: TraceAxisScore; // Optional TRACE chip; may be derived when Retrieved and explicit chip values are absent.
    freshnessScore?: TraceAxisScore; // Optional TRACE chip; may be derived when Retrieved and explicit chip values are absent.
    // TRACE posture is answer-shape metadata only.
    // Keep this separate from workflowMode (execution policy) and provenance
    // classification/record fields.
    // TODO(trace-lifecycle-summary): Current TRACE contract is summary-state.
    // If TRACE later evolves across multiple runtime steps, model canonical
    // lifecycle/history first and derive summary fields from it.
    trace_target: PartialResponseTemperament;
    trace_final: PartialResponseTemperament;
    trace_final_reason_code?: TraceFinalizationReasonCode;
    trustGraph?: TrustGraphMetadata;
    imageGeneration?: ImageGenerationMetadata;
};
