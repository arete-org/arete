/**
 * @description: Canonical backend response metadata assembly from assistant
 * output metadata plus runtime execution context.
 * @footnote-scope: utility
 * @footnote-module: OpenAIServiceMetadata
 * @footnote-risk: high - Metadata mistakes can misclassify provenance, TRACE chips, and execution timeline.
 * @footnote-ethics: high - Users depend on this metadata for transparency and governance trust.
 */

import crypto from 'node:crypto';
import type {
    ExecutionEvent,
    ExecutionReasonCode,
    ExecutionStatus,
    EvaluatorExecutionReasonCode,
    GenerationExecutionReasonCode,
    ResponseMetadata,
    SafetyTier,
    ToolInvocationReasonCode,
    TraceAxisScore,
} from '@footnote/contracts/ethics-core';
import { deriveReviewRuntimeSummary } from '@footnote/contracts/ethics-core';
import { runtimeConfig } from '../../config.js';
import { logger } from '../../utils/logger.js';
import {
    classifyProvenanceWithSignals,
    deriveRetrievedChips,
    resolveTradeoffCount,
} from '../responseMetadataHeuristics.js';
import type {
    AssistantResponseMetadata,
    ResponseMetadataRuntimeContext,
} from './types.js';

// Owns: response metadata assembly and normalization of execution metadata fields.
// Does not own: making provider calls or deciding chat policy.

const TRACE_AXIS_KEYS = [
    'tightness',
    'rationale',
    'attribution',
    'caution',
    'extent',
] as const;

/**
 * Runtime guard for TRACE axis chip values.
 */
const isTraceAxisScore = (value: unknown): value is TraceAxisScore =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5;

/**
 * Keeps only valid TRACE planner axes so downstream metadata stays schema-safe.
 */
const normalizePlannerTemperament = (
    temperament: ResponseMetadataRuntimeContext['plannerTemperament']
): ResponseMetadataRuntimeContext['plannerTemperament'] => {
    if (!temperament) {
        return undefined;
    }

    const normalized: NonNullable<
        ResponseMetadataRuntimeContext['plannerTemperament']
    > = {};
    for (const axis of TRACE_AXIS_KEYS) {
        const score = temperament[axis];
        if (isTraceAxisScore(score)) {
            normalized[axis] = score;
        }
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const normalizeEvaluatorReasonCode = (
    status: ExecutionStatus,
    reasonCode: ExecutionReasonCode | undefined
): EvaluatorExecutionReasonCode | undefined => {
    if (status === 'executed' || status === 'skipped') {
        return undefined;
    }

    if (reasonCode === 'evaluator_runtime_error') {
        return reasonCode;
    }

    return undefined;
};

const normalizeGenerationReasonCode = (
    status: ExecutionStatus,
    reasonCode: ExecutionReasonCode | undefined
): GenerationExecutionReasonCode | undefined => {
    if (status === 'executed' || status === 'skipped') {
        return undefined;
    }

    if (reasonCode === 'generation_runtime_error') {
        return reasonCode;
    }

    return undefined;
};

const normalizeToolReasonCode = (
    status: ExecutionStatus,
    reasonCode: ToolInvocationReasonCode | undefined
): ToolInvocationReasonCode | undefined => {
    if (
        reasonCode === 'tool_not_requested' ||
        reasonCode === 'tool_not_used' ||
        reasonCode === 'search_rerouted_to_fallback_profile' ||
        reasonCode === 'search_reroute_not_permitted_by_selection_source' ||
        reasonCode === 'search_reroute_no_tool_capable_fallback_available' ||
        reasonCode === 'tool_unavailable' ||
        reasonCode === 'tool_execution_error' ||
        reasonCode === 'tool_timeout' ||
        reasonCode === 'tool_http_error' ||
        reasonCode === 'tool_network_error' ||
        reasonCode === 'tool_invalid_response' ||
        reasonCode === 'search_not_supported_by_selected_profile' ||
        reasonCode === 'unspecified_tool_outcome'
    ) {
        return reasonCode;
    }

    if (status === 'executed') {
        return undefined;
    }

    return status === 'failed'
        ? 'tool_execution_error'
        : 'unspecified_tool_outcome';
};

/**
 * Builds canonical ResponseMetadata for trace storage and UI rendering.
 * All values are derived from control-plane context and API annotations.
 *
 * Semantics guardrail:
 * - execution/workflow are structural record surfaces for what happened.
 * - workflowMode is execution-policy metadata.
 * - TRACE (trace_target/trace_final + optional chips) is answer-posture metadata.
 * - planner influence is represented in workflow.steps[] (stepKind=plan).
 * - steerability control influence is represented in steerabilityControls.
 * - provenance/provenanceAssessment are compact grounding classification-method
 *   metadata and may include deterministic heuristic derivation.
 */
const buildResponseMetadata = (
    assistantMetadata: AssistantResponseMetadata,
    runtimeContext: ResponseMetadataRuntimeContext
): ResponseMetadata => {
    const responseId = crypto.randomBytes(6).toString('base64url').slice(0, 8);
    const chainHash = crypto
        .createHash('sha256')
        .update(runtimeContext.conversationSnapshot)
        .digest('hex')
        .substring(0, 16);
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

    const citations = Array.isArray(assistantMetadata.citations)
        ? assistantMetadata.citations
        : [];
    const retrieval = runtimeContext.retrieval;
    const classificationToolExecution = runtimeContext.executionContext?.tool;
    const retrievalToolExecuted =
        classificationToolExecution?.status === 'executed' &&
        classificationToolExecution.toolName === 'web_search';
    const provenanceClassification = classifyProvenanceWithSignals({
        assistantProvenance: assistantMetadata.provenance,
        citationCount: citations.length,
        retrievalRequested: retrieval?.requested ?? false,
        retrievalUsed: retrieval?.used ?? false,
        retrievalToolExecuted,
        workflowEvidence: runtimeContext.workflow !== undefined,
        trustGraphEvidenceAvailable:
            runtimeContext.trustGraphEvidenceAvailable ?? false,
        trustGraphEvidenceUsed: runtimeContext.trustGraphEvidenceUsed ?? false,
    });
    // TODO(provenance-structural-first): Reduce heuristic dependence here by
    // preferring explicit runtime retrieval/tool evidence signals wherever they
    // are available and contract-stable.
    const provenance = provenanceClassification.provenance;
    const provenanceAssessment = provenanceClassification.assessment;
    const tradeoffCount = resolveTradeoffCount(
        assistantMetadata.tradeoffCount,
        runtimeContext.plannerTemperament
    );
    // TODO(trace-lifecycle): TRACE may eventually evolve through planning /
    // workflow / review steps. If that model is added, keep canonical
    // lifecycle/history state and derive summary fields from it.
    // Current runtime stays summary-only and does not implement lifecycle.
    const traceTarget =
        normalizePlannerTemperament(runtimeContext.plannerTemperament) ?? {};
    const traceFinal =
        normalizePlannerTemperament(runtimeContext.finalTemperament) ??
        traceTarget;
    const traceChanged =
        JSON.stringify(traceTarget) !== JSON.stringify(traceFinal);
    const traceFinalReasonCode = traceChanged
        ? (runtimeContext.temperamentFinalizationReasonCode ??
          'runtime_posture_adjustment')
        : undefined;
    if (
        traceChanged &&
        runtimeContext.temperamentFinalizationReasonCode === undefined
    ) {
        logger.warn(
            'TRACE target/final divergence reason code missing; defaulting to runtime_posture_adjustment.',
            {
                responseId,
            }
        );
    }
    const evidenceScore = isTraceAxisScore(assistantMetadata.evidenceScore)
        ? assistantMetadata.evidenceScore
        : undefined;
    const freshnessScore = isTraceAxisScore(assistantMetadata.freshnessScore)
        ? assistantMetadata.freshnessScore
        : undefined;
    // TRACE chips remain posture-facing summaries even when deterministically
    // derived from retrieval-context signals.
    const shouldDeriveRetrievedChips =
        provenance === 'Retrieved' &&
        (evidenceScore === undefined || freshnessScore === undefined);
    const derivedRetrievedChips = shouldDeriveRetrievedChips
        ? deriveRetrievedChips({
              citationCount: citations.length,
              intent: retrieval?.intent,
              contextSize: retrieval?.contextSize,
          })
        : undefined;
    const finalEvidenceScore =
        evidenceScore ?? derivedRetrievedChips?.evidenceScore;
    const finalFreshnessScore =
        freshnessScore ?? derivedRetrievedChips?.freshnessScore;

    if (
        provenance === 'Retrieved' &&
        (finalEvidenceScore === undefined || finalFreshnessScore === undefined)
    ) {
        logger.error(
            'Retrieved response metadata is missing required evidence/freshness chips.',
            {
                responseId,
                retrievalRequested: retrieval?.requested ?? false,
                retrievalUsed: retrieval?.used ?? false,
            }
        );
    }

    const safetyTier: SafetyTier = 'Low';
    const licenseContext = 'MIT + HL3';
    const execution: ExecutionEvent[] = [];
    const evaluatorExecution = runtimeContext.executionContext?.evaluator;
    if (evaluatorExecution) {
        // The evaluator already decided this. We are only copying that result
        // into the response timeline.
        const normalizedEvaluatorReasonCode = normalizeEvaluatorReasonCode(
            evaluatorExecution.status,
            evaluatorExecution.reasonCode
        );
        execution.push({
            kind: 'evaluator',
            status: evaluatorExecution.status,
            ...(evaluatorExecution.outcome !== undefined && {
                evaluator: evaluatorExecution.outcome,
            }),
            ...(normalizedEvaluatorReasonCode !== undefined && {
                reasonCode: normalizedEvaluatorReasonCode,
            }),
            ...(evaluatorExecution.durationMs !== undefined && {
                durationMs: evaluatorExecution.durationMs,
            }),
        });
    }
    const toolExecution = runtimeContext.executionContext?.tool;
    if (toolExecution) {
        // Keep the tool event compact. Readers usually need to know whether it
        // ran and how it ended, not the full request payload.
        const normalizedToolReasonCode = normalizeToolReasonCode(
            toolExecution.status,
            toolExecution.reasonCode
        );
        execution.push({
            kind: 'tool',
            status: toolExecution.status,
            toolName: toolExecution.toolName,
            ...(normalizedToolReasonCode !== undefined && {
                reasonCode: normalizedToolReasonCode,
            }),
            ...(toolExecution.durationMs !== undefined && {
                durationMs: toolExecution.durationMs,
            }),
        });
    }
    const generationExecution = runtimeContext.executionContext?.generation;
    if (generationExecution) {
        // The generation event is the real source of model information.
        // `modelVersion` below only exists for older consumers.
        const normalizedGenerationReasonCode = normalizeGenerationReasonCode(
            generationExecution.status,
            generationExecution.reasonCode
        );
        execution.push({
            kind: 'generation',
            status: generationExecution.status,
            profileId: generationExecution.profileId,
            ...(generationExecution.originalProfileId !== undefined && {
                originalProfileId: generationExecution.originalProfileId,
            }),
            ...(generationExecution.effectiveProfileId !== undefined && {
                effectiveProfileId: generationExecution.effectiveProfileId,
            }),
            provider: generationExecution.provider,
            model: generationExecution.model,
            ...(normalizedGenerationReasonCode !== undefined && {
                reasonCode: normalizedGenerationReasonCode,
            }),
            ...(generationExecution.durationMs !== undefined && {
                durationMs: generationExecution.durationMs,
            }),
        });
    }
    // TODO(workflow-execution-metadata): Extend execution events with lineage
    // (id/parentId), timing (startedAt/finishedAt), and per-step usage/cost
    // once multi-step workflow execution is enabled.
    const generationEventModel = execution
        .filter((event) => event.kind === 'generation')
        .at(-1)?.model;
    const reviewRuntime = deriveReviewRuntimeSummary({
        workflow: runtimeContext.workflow,
        workflowMode: runtimeContext.workflowMode,
        execution,
    });

    return {
        responseId,
        provenance,
        safetyTier,
        tradeoffCount,
        chainHash,
        licenseContext,
        // TODO(workflow-execution-metadata): Remove modelVersion after metadata
        // consumers migrate to execution[] as canonical timeline authority.
        // Compatibility mirror for legacy consumers that still read only a
        // single model string.
        modelVersion:
            generationEventModel ??
            runtimeContext.modelVersion ??
            runtimeConfig.openai.defaultModel,
        staleAfter: new Date(Date.now() + ninetyDaysMs).toISOString(),
        citations,
        provenanceAssessment,
        ...(runtimeContext.totalDurationMs !== undefined && {
            totalDurationMs: runtimeContext.totalDurationMs,
        }),
        ...(execution.length > 0 && { execution }),
        ...(runtimeContext.workflow !== undefined && {
            workflow: runtimeContext.workflow,
        }),
        reviewRuntime,
        ...(runtimeContext.workflowMode !== undefined && {
            workflowMode: runtimeContext.workflowMode,
        }),
        ...(runtimeContext.steerabilityControls !== undefined && {
            steerabilityControls: runtimeContext.steerabilityControls,
        }),
        ...(evaluatorExecution?.outcome !== undefined && {
            evaluator: evaluatorExecution.outcome,
        }),
        trace_target: traceTarget,
        trace_final: traceFinal,
        ...(traceFinalReasonCode !== undefined && {
            trace_final_reason_code: traceFinalReasonCode,
        }),
        ...(finalEvidenceScore !== undefined && {
            evidenceScore: finalEvidenceScore,
        }),
        ...(finalFreshnessScore !== undefined && {
            freshnessScore: finalFreshnessScore,
        }),
    };
};

export { buildResponseMetadata };
