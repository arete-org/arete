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
 * Provenance describes where the answer "came from" at a high level.
 */
export type Provenance = 'Retrieved' | 'Inferred' | 'Speculative';

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
    | 'tool_not_used'
    | 'search_not_supported_by_selected_profile'
    | 'unspecified_tool_outcome';

export type EvaluatorDecisionMode = 'observe_only' | 'enforced';

/**
 * Deterministic evaluator outcome emitted during orchestration.
 * This stays additive and non-blocking while strict breaker enforcement rolls
 * out incrementally.
 */
export type EvaluatorOutcome = {
    mode: EvaluatorDecisionMode;
    riskTier: RiskTier;
    provenance: Provenance;
    breakerTriggered: boolean;
    breakerReason?: string;
};

/**
 * One backend-owned execution timeline entry for this response.
 *
 * This v1 shape is intentionally compact and is expected to grow once
 * workflow-based execution is enabled (lineage, timing, and per-step usage).
 */
export type ExecutionEvent = {
    kind: 'planner' | 'evaluator' | 'tool' | 'generation';
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
