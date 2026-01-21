/**
 * @description: Public entry point for shared type contracts used across packages.
 * @arete-scope: interface
 * @arete-module: ContractsIndex
 * @arete-risk: low - Incorrect exports can cause type drift between packages.
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
} from './ethics-core';
