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
    ProvenanceAssessment,
    TraceAxisScore,
    ResponseTemperament,
    PartialResponseTemperament,
    ExecutionStatus,
    ExecutionReasonCode,
    PlannerExecutionReasonCode,
    PlannerExecutionPurpose,
    PlannerExecutionContractType,
    PlannerExecutionApplyOutcome,
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
    WorkflowStepKind,
    WorkflowTerminationReason,
    StepOutcome,
    StepRecord,
    WorkflowRecord,
    EvaluatorAuthorityLevel,
    WorkflowModeId,
    WorkflowModeSelectionSource,
    WorkflowModeEvidencePosture,
    WorkflowModeBehavior,
    WorkflowModeDecision,
    SteerabilityControlId,
    SteerabilityControlSource,
    SteerabilityImpactTarget,
    SteerabilityControlRecord,
    SteerabilityControls,
    EvaluatorDecisionMode,
    SafetyAction,
    SafetyReasonCode,
    SafetyEvaluationInput,
    SafetyEvaluationResult,
    SafetyDecision,
    EvaluatorOutcome,
    ExecutionEvent,
    TrustGraphMetadata,
    ResponseMetadata,
} from './types.js';
export {
    WORKFLOW_STEP_STATUSES,
    WORKFLOW_STEP_KINDS,
    WORKFLOW_TERMINATION_REASONS,
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
export {
    resolveBreakerDecisionContext,
    type BreakerDecisionSource,
    type BreakerDecisionContext,
} from './breakerDecision.js';
