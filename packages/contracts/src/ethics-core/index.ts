/**
 * @description: Ethics-core contract exports for provenance and response metadata.
 * @arete-scope: interface
 * @arete-module: EthicsCoreContractsIndex
 * @arete-risk: low - Export mistakes can misalign types across packages.
 * @arete-ethics: moderate - Types document data meaning but do not execute logic.
 */

// This file is intentionally small. It only re-exports types so every package
// can import from one place without pulling in runtime code.

export type {
    Provenance,
    RiskTier,
    ConfidenceScore,
    Citation,
    ResponseMetadata,
} from './types';
