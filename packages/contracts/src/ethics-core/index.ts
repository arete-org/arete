/**
 * @description: Ethics-core contract exports for provenance and response metadata.
 * @footnote-scope: interface
 * @footnote-module: EthicsCoreContractsIndex
 * @footnote-risk: low - Export mistakes can misalign types across packages.
 * @footnote-ethics: medium - Types document data meaning but do not execute logic.
 */

// This file is intentionally small. It only re-exports types so every package
// can import from one place without pulling in runtime code.

export type {
    Provenance,
    RiskTier,
    Citation,
    TraceAxisScore,
    ResponseTemperament,
    PartialResponseTemperament,
    ExecutionStatus,
    ExecutionReasonCode,
    ExecutionEvent,
    ResponseMetadata,
} from './types.js';
