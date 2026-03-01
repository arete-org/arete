/**
 * @description: Public exports for ethics-core types and evaluators.
 * @footnote-scope: interface
 * @footnote-module: EthicsCoreIndex
 * @footnote-risk: low - Export changes can break downstream imports.
 * @footnote-ethics: low - This module re-exports without processing data.
 */
// Export types
// Re-export public types from types.ts
export type {
    Provenance,
    RiskTier,
    ConfidenceScore,
    Citation,
    ResponseMetadata,
} from './types.js';

// Export functions
export { computeProvenance, computeRiskTier } from './evaluators.js';

