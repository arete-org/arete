/**
 * @description: Shared type contracts for response provenance, risk, and metadata.
 * @arete-scope: interface
 * @arete-module: EthicsCoreContracts
 * @arete-risk: low - Incorrect shapes can break UI assumptions or validation.
 * @arete-ethics: moderate - Types document data meaning but do not execute logic.
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
};
