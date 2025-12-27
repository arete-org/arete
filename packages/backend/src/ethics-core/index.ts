/**
 * @description: Public exports for ethics-core types and evaluators.
 * @arete-scope: interface
 * @arete-module: EthicsCoreIndex
 * @arete-risk: low - Export changes can break downstream imports.
 * @arete-ethics: low - This module re-exports without processing data.
 */
// Export types
// Re-export public types from types.ts
export type {
  Provenance,
  RiskTier,
  ConfidenceScore,
  Citation,
  ResponseMetadata
} from './types';

// Export functions
export { computeProvenance, computeRiskTier } from './evaluators';
