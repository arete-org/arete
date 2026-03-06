/**
 * @description: Public exports for ethics-core types and evaluators.
 * @footnote-scope: interface
 * @footnote-module: EthicsCoreIndex
 * @footnote-risk: low - Export changes can break downstream imports.
 * @footnote-ethics: low - This module re-exports without processing data.
 */
// Export types
// Re-export public types from the shared contracts package.
export type {
    Provenance,
    RiskTier,
    Citation,
    ResponseMetadata,
} from '@footnote/contracts/ethics-core';

// Export functions
export { computeProvenance, computeRiskTier } from './evaluators.js';
