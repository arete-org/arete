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
 * ConfidenceScore is a number from 0.0 to 1.0.
 * 0 means "not confident"; 1 means "very confident".
 */
export type ConfidenceScore = number;

/**
 * A citation points to a source used in a response.
 */
export type Citation = {
    title: string;
    url: string;
    snippet?: string;
};

/**
 * TraceAxisScore is a single TRACE axis value on a 1..10 scale.
 * TypeScript enforces this range for typed literals.
 */
export type TraceAxisScore = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/**
 * ResponseTemperament captures TRACE (response temperament) as five normalized
 * integer axes:
 * T = tightness, R = rationale, A = attribution, C = caution, E = extent.
 *
 * Scale: each axis is an integer from 1 to 10.
 * Runtime payloads still require schema validation.
 */
export type ResponseTemperament = {
    tightness: TraceAxisScore; // 1 to 10: concision and structural efficiency.
    rationale: TraceAxisScore; // 1 to 10: amount of visible rationale and trade-off explanation.
    attribution: TraceAxisScore; // 1 to 10: clarity of sourced vs inferred boundaries.
    caution: TraceAxisScore; // 1 to 10: safeguard posture and overclaim restraint.
    extent: TraceAxisScore; // 1 to 10: breadth of viable options and perspectives.
};

/**
 * ResponseMetadata is the compact record attached to a model response.
 */
export type ResponseMetadata = {
    responseId: string; // Short id for trace lookups and links.
    provenance: Provenance; // High-level origin label for the response.
    confidence: ConfidenceScore; // 0.0 to 1.0 confidence score.
    riskTier: RiskTier; // Sensitivity level used by UI and reviewers.
    tradeoffCount: number; // Number of trade-offs the model surfaced.
    chainHash: string; // Short hash to help detect tampering.
    licenseContext: string; // Human-readable license label.
    modelVersion: string; // The model id or version string.
    staleAfter: string; // ISO timestamp after which the data is stale.
    citations: Citation[]; // Sources used for the answer.
    imageDescriptions?: string[]; // Optional captions for any images used.
    // TODO(TRACE-rollout): Make required after TRACE ingestion and rendering
    // paths are fully implemented and validated across surfaces.
    temperament?: ResponseTemperament;
};

