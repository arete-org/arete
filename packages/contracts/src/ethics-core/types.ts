/**
 * @description: Shared type contracts for response provenance, risk, and metadata.
 * @footnote-scope: interface
 * @footnote-module: EthicsCoreContracts
 * @footnote-risk: low - Incorrect shapes can break UI assumptions or validation.
 * @footnote-ethics: medium - Types document data meaning but do not execute logic.
 */

// This file is the single source of truth for cross-package metadata shapes.
// It is intentionally "types only": no functions and no runtime behavior.

/**
 * RiskTier labels how sensitive a response is.
 * The UI uses this to choose colors and display warnings.
 */
export type RiskTier = 'Low' | 'Medium' | 'High';

/**
 * Stable deterministic rule IDs emitted by the backend risk evaluator.
 * Values are versioned so future rule changes can roll forward safely.
 */
export type RiskRuleId =
    | 'risk.self_harm.crisis_intent.v1'
    | 'risk.safety.weaponization_request.v1'
    | 'risk.professional.medical_or_legal_advice.v1';

/**
 * Deterministic risk evaluation output used for audit and tests.
 */
export type RiskEvaluationResult = {
    riskTier: RiskTier;
    ruleId: RiskRuleId | null;
    matchedRuleIds: RiskRuleId[];
};

/**
 * Provenance describes where the answer "came from" at a high level.
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
 */
export type PartialResponseTemperament = Partial<ResponseTemperament>;

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
    | 'search_not_supported_by_selected_profile'
    | 'unspecified_tool_outcome';

export type PlannerExecutionReasonCode = Extract<
    ExecutionReasonCode,
    'planner_runtime_error' | 'planner_invalid_output'
>;

export type EvaluatorExecutionReasonCode = Extract<
    ExecutionReasonCode,
    'evaluator_runtime_error'
>;

export type GenerationExecutionReasonCode = Extract<
    ExecutionReasonCode,
    'generation_runtime_error'
>;

export type EvaluatorDecisionMode = 'observe_only' | 'enforced';

export type SafetyBreakerAction =
    | 'allow'
    | 'block'
    | 'redirect'
    | 'safe_partial'
    | 'human_review';

export type SafetyBreakerReasonCode =
    | 'self_harm_crisis_intent'
    | 'weaponization_request'
    | 'professional_advice_guardrail';

export type SafetyDecision =
    | {
          action: 'allow';
          riskTier: RiskTier;
          ruleId: null;
      }
    | {
          action: Exclude<SafetyBreakerAction, 'allow'>;
          riskTier: RiskTier;
          ruleId: RiskRuleId;
          reasonCode: SafetyBreakerReasonCode;
          reason: string;
      };

/**
 * Deterministic evaluator outcome emitted during orchestration.
 * This stays additive and non-blocking while strict breaker enforcement rolls
 * out incrementally.
 */
export type EvaluatorOutcome = {
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
          type: 'gridpoint';
          office: string;
          gridX: number;
          gridY: number;
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
 */
export type ToolInvocationRequest = {
    toolName: ToolInvocationName;
    requested: boolean;
    eligible: boolean;
    reasonCode?: ToolInvocationReasonCode;
};

/**
 * Runtime-owned final tool outcome emitted into execution metadata.
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
export type ExecutionEvent = {
    kind: ExecutionEventKind;
    status: ExecutionStatus;
    originalProfileId?: string;
    effectiveProfileId?: string;
    profileId?: string;
    provider?: string;
    model?: string;
    toolName?: string;
    evaluator?: EvaluatorOutcome;
    reasonCode?: ExecutionReasonCode;
    durationMs?: number;
};

/**
 * ResponseMetadata is the compact record attached to a model response.
 */
export type ResponseMetadata = {
    responseId: string; // Short id for trace lookups and links.
    provenance: Provenance; // High-level origin label for the response.
    riskTier: RiskTier; // Sensitivity level used by UI and reviewers.
    tradeoffCount: number; // Number of trade-offs the model surfaced.
    chainHash: string; // Short hash to help detect tampering.
    licenseContext: string; // Human-readable license label.
    /** @deprecated Prefer execution[] as the canonical model/runtime timeline. */
    modelVersion: string; // Compatibility mirror of the final generation model.
    staleAfter: string; // ISO timestamp after which the data is stale.
    totalDurationMs?: number; // End-to-end orchestration duration when available.
    citations: Citation[]; // Sources used for the answer.
    execution?: ExecutionEvent[]; // Canonical execution timeline for model/tool visibility.
    evaluator?: EvaluatorOutcome; // Deterministic evaluator decision captured before breaker enforcement.
    imageDescriptions?: string[]; // Optional captions for any images used.
    evidenceScore?: TraceAxisScore; // Optional TRACE evidence chip score (1..5).
    freshnessScore?: TraceAxisScore; // Optional TRACE freshness chip score (1..5).
    // TODO(TRACE-rollout): Make required after TRACE ingestion and rendering
    // paths are fully implemented and validated across surfaces.
    temperament?: PartialResponseTemperament;
};
