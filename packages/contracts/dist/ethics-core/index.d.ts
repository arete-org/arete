/**
 * @description: Ethics-core contract exports for provenance and response metadata.
 * @arete-scope: interface
 * @arete-module: EthicsCoreContractsIndex
 * @arete-risk: low - Export mistakes can misalign types across packages.
 * @arete-ethics: medium - Types document data meaning but do not execute logic.
 */
export type { Provenance, RiskTier, ConfidenceScore, Citation, ResponseMetadata, } from './types';
