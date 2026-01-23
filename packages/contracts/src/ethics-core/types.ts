/**
 * @description: Shared type contracts for response provenance, risk, and metadata.
 * @arete-scope: interface
 * @arete-module: EthicsCoreContracts
 * @arete-risk: low - Incorrect shapes can break UI assumptions or validation.
 * @arete-ethics: medium - Types document data meaning but do not execute logic.
 */

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
    responseId: string;
    provenance: Provenance;
    confidence: ConfidenceScore;
    riskTier: RiskTier;
    tradeoffCount: number;
    chainHash: string;
    licenseContext: string;
    modelVersion: string;
    staleAfter: string;
    citations: Citation[];
    imageDescriptions?: string[];
};
