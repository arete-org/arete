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
    SafetyTier,
    SafetyRuleId,
    Citation,
    TraceAxisScore,
    ResponseTemperament,
    PartialResponseTemperament,
    ExecutionStatus,
    ExecutionReasonCode,
    PlannerExecutionReasonCode,
    EvaluatorExecutionReasonCode,
    GenerationExecutionReasonCode,
    ToolInvocationName,
    ToolInvocationReasonCode,
    ToolInvocationIntent,
    ToolInvocationRequest,
    ToolExecutionContext,
    CorrelationEnvelope,
    ExecutionEventKind,
    PlannerExecutionEvent,
    EvaluatorExecutionEvent,
    ToolExecutionEvent,
    GenerationExecutionEvent,
    WorkflowStepStatus,
    WorkflowTerminationReason,
    WorkflowStep,
    WorkflowLineage,
    EvaluatorDecisionMode,
    SafetyAction,
    SafetyReasonCode,
    SafetyEvaluationInput,
    SafetyEvaluationResult,
    SafetyDecision,
    EvaluatorOutcome,
    ExecutionEvent,
    ResponseMetadata,
} from './types.js';
export { formatExecutionTimelineSummary } from './executionFormatting.js';
export {
    SafetyRuleIdSchema,
    SafetyActionSchema,
    SafetyReasonCodeSchema,
    SafetyDecisionSchema,
} from './schemas.js';
export {
    SAFETY_RULE_METADATA,
    type SafetyRuleMetadata,
} from './safetyRuleMetadata.js';
