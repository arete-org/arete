/**
 * @description: Defines ethics-core types used for provenance, risk, and metadata.
 * @arete-scope: interface
 * @arete-module: EthicsCoreRuntimeTypes
 * @arete-risk: low - Type drift can break downstream assumptions or validations.
 * @arete-ethics: low - Types document semantics without processing data.
 */
/**
 * RiskTier classifies the sensitivity of a response.
 * - low: General knowledge, casual topics
 * - medium: Nuanced advice, education, workplace
 * - high: Sensitive topics near circuit-breaker thresholds
 * Includes standard colors for UI representation.
 */
export type RiskTier = "Low" | "Medium" | "High";

/**
 * Provenance indicates the epistemic origin of a response.
 * - retrieved: Grounded in external sources (web search, documents)
 * - inferred: Logical deduction from context
 * - speculative: Educated guess (lower confidence)
 */
export type Provenance = "Retrieved" | "Inferred" | "Speculative";

/**
 * Calculated confidence score (0.0–1.0) reflects the system's certainty
 * about the accuracy and reliability of the response.
 */
export type ConfidenceScore = number; // 0.0 to 1.0

/**
 * Citation represents a source used in the response.
 */
export type Citation = {
    title: string;
    url: URL;
    snippet?: string; // Optional excerpt from source
}

/**
 * The complete provenance package for a response.
 */
export type ResponseMetadata = {
    responseId: string;           // Unique short ID
    provenance: Provenance;       // Epistemic origin
    confidence: ConfidenceScore;  // 0.0-1.0 confidence
    riskTier: RiskTier;           // Sensitivity classification
    tradeoffCount: number;        // Number of competing values surfaced
    chainHash: string;            // Cryptographic hash of reasoning chain
    licenseContext: string;       // e.g., "MIT + HL3"
    modelVersion: string;         // e.g., "gpt-5-mini"
    staleAfter: string;           // ISO 8601 timestamp
    citations: Citation[];        // Sources consulted
    imageDescriptions?: string[]; // Optional image description payloads captured during response generation
}
