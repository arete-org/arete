/**
 * @description: Public entry point for shared type contracts used across packages.
 * @arete-scope: interface
 * @arete-module: ContractsIndex
 * @arete-risk: low - Incorrect exports can cause type drift between packages.
 * @arete-ethics: medium - Types document data meaning but do not execute logic.
 */
export type { Provenance, RiskTier, ConfidenceScore, Citation, ResponseMetadata, } from './ethics-core';
