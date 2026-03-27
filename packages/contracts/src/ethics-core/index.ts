/**
 * @description: Ethics-core contract exports for provenance and response metadata.
 * @footnote-scope: interface
 * @footnote-module: EthicsCoreContractsIndex
 * @footnote-risk: low - Export mistakes can misalign types across packages.
 * @footnote-ethics: medium - Types document data meaning but do not execute logic.
 */

// This file is intentionally small. It re-exports shared ethics-core types and
// runtime helpers (for example, formatExecutionTimelineSummary) so every
// package can import from one place.

export type {
    Provenance,
    ProvenanceSignals,
    RiskTier,
    RiskRuleId,
    RiskEvaluationResult,
    Citation,
    TraceAxisScore,
    ResponseTemperament,
    PartialResponseTemperament,
    ExecutionStatus,
    ExecutionReasonCode,
    EvaluatorDecisionMode,
    EvaluatorOutcome,
    ExecutionEvent,
    ResponseMetadata,
} from './types.js';
export { formatExecutionTimelineSummary } from './executionFormatting.js';
