/**
 * @description: Validates the shared request and response payloads used by Footnote's main web-facing APIs.
 * @footnote-scope: interface
 * @footnote-module: WebContractSchemas
 * @footnote-risk: medium - Schema drift can reject valid traffic or allow invalid payloads.
 * @footnote-ethics: medium - Validation quality affects provenance clarity and user trust.
 */

import { z } from 'zod';
import {
    WORKFLOW_STEP_KINDS,
    WORKFLOW_STEP_STATUSES,
    WORKFLOW_TERMINATION_REASONS,
    type ProvenanceAssessment,
    type SteerabilityControls,
    type TraceAxisScore,
    type TrustGraphMetadata,
} from '../ethics-core/index.js';
import { SafetyDecisionSchema } from '../ethics-core/schemas.js';
import type { ApiResponseValidationResult } from './client-core.js';
import {
    internalImageRenderModels,
    internalImageTextModels,
    supportedImageOutputFormats,
} from '../providers.js';

const ProvenanceSchema = z.enum(['Retrieved', 'Inferred', 'Speculative']);
const SafetyTierSchema = z.enum(['Low', 'Medium', 'High']);
const IncidentStatusSchema = z.enum([
    'new',
    'under_review',
    'confirmed',
    'dismissed',
    'resolved',
]);
const IncidentAuditActionSchema = z.enum([
    'incident.created',
    'incident.remediated',
    'incident.status_changed',
    'incident.note_added',
]);
const IncidentRemediationStateSchema = z.enum([
    'pending',
    'applied',
    'already_marked',
    'skipped_not_assistant',
    'failed',
]);
const ChatSurfaceSchema = z.enum(['web', 'discord']);
const ChatTriggerKindSchema = z.enum([
    'submit',
    'direct',
    'invoked',
    'catchup',
]);
const ChatPersonaIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const ChatProfileIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const ChatConversationMessageSchema = z
    .object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string().min(1),
        authorName: z.string().min(1).optional(),
        authorId: z.string().min(1).optional(),
        messageId: z.string().min(1).optional(),
        createdAt: z.string().min(1).optional(),
    })
    .strict();
const ChatAttachmentSchema = z
    .object({
        kind: z.literal('image'),
        url: z.string().url(),
        contentType: z.string().min(1).optional(),
    })
    .strict();
const ChatCapabilitiesSchema = z
    .object({
        canReact: z.boolean(),
        canGenerateImages: z.boolean(),
        canUseTts: z.boolean(),
    })
    .strict();
const ChatImageRequestSchema = z
    .object({
        prompt: z.string().min(1),
        aspectRatio: z
            .enum(['auto', 'square', 'portrait', 'landscape'])
            .optional(),
        background: z.string().min(1).optional(),
        quality: z.enum(['low', 'medium', 'high', 'auto']).optional(),
        style: z.string().min(1).optional(),
        allowPromptAdjustment: z.boolean().optional(),
        followUpResponseId: z.string().min(1).optional(),
        outputFormat: z.enum(['png', 'webp', 'jpeg']).optional(),
        outputCompression: z.number().int().min(1).max(100).optional(),
    })
    .strict();
export const InternalNewsItemSchema = z
    .object({
        title: z.string().min(1),
        summary: z.string().min(1),
        url: z.string().url(),
        source: z.string().min(1),
        timestamp: z.string().datetime().optional(),
        thumbnail: z.string().url().nullable().optional(),
        image: z.string().url().nullable().optional(),
    })
    .strict();

/**
 * Shared citation schema used in reflect/traces metadata payloads.
 */
export const CitationSchema = z
    .object({
        title: z.string(),
        url: z.string().url(),
        snippet: z.string().optional(),
    })
    .strict();

/**
 * TRACE temperament profile:
 * - [T]ightness: concision and structural efficiency
 * - [R]ationale: amount of visible rationale and trade-off explanation
 * - [A]ttribution: clarity of sourced vs inferred boundaries
 * - [C]aution: safeguard posture and overclaim restraint
 * - [E]xtent: breadth of viable options and perspectives
 *
 * We use literal values (1..5) instead of a broad number schema so Zod output
 * matches the TraceAxisScore contract type exactly.
 */
const TraceAxisScoreSchema: z.ZodType<TraceAxisScore> = z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
]);

const ResponseTemperamentSchema = z
    .object({
        tightness: TraceAxisScoreSchema,
        rationale: TraceAxisScoreSchema,
        attribution: TraceAxisScoreSchema,
        caution: TraceAxisScoreSchema,
        extent: TraceAxisScoreSchema,
    })
    .strict();
const PartialResponseTemperamentSchema = ResponseTemperamentSchema.partial();
const ExecutionStatusSchema = z.enum(WORKFLOW_STEP_STATUSES);
const ExecutionReasonCodeSchema = z.enum([
    'planner_runtime_error',
    'planner_invalid_output',
    'evaluator_runtime_error',
    'generation_runtime_error',
    'tool_not_requested',
    'tool_not_used',
    'search_rerouted_to_fallback_profile',
    'search_reroute_not_permitted_by_selection_source',
    'search_reroute_no_tool_capable_fallback_available',
    'tool_unavailable',
    'tool_execution_error',
    'tool_timeout',
    'tool_http_error',
    'tool_network_error',
    'tool_invalid_response',
    'search_not_supported_by_selected_profile',
    'unspecified_tool_outcome',
]);
const PlannerExecutionReasonCodeSchema = z.enum([
    'planner_runtime_error',
    'planner_invalid_output',
]);
const EvaluatorExecutionReasonCodeSchema = z.enum(['evaluator_runtime_error']);
const GenerationExecutionReasonCodeSchema = z.enum([
    'generation_runtime_error',
]);
const ToolExecutionReasonCodeSchema = z.enum([
    'tool_not_requested',
    'tool_not_used',
    'search_rerouted_to_fallback_profile',
    'search_reroute_not_permitted_by_selection_source',
    'search_reroute_no_tool_capable_fallback_available',
    'tool_unavailable',
    'tool_execution_error',
    'tool_timeout',
    'tool_http_error',
    'tool_network_error',
    'tool_invalid_response',
    'search_not_supported_by_selected_profile',
    'unspecified_tool_outcome',
]);
const EvaluatorAuthorityLevelSchema = z.enum([
    'observe',
    'influence',
    'enforce',
]);
const EvaluatorDecisionModeSchema = z.enum(['observe_only', 'enforced']);
const EvaluatorOutcomeSchema = z
    .object({
        authorityLevel: EvaluatorAuthorityLevelSchema.optional(),
        mode: EvaluatorDecisionModeSchema,
        provenance: ProvenanceSchema,
        safetyDecision: SafetyDecisionSchema,
    })
    .superRefine((value, context) => {
        if (value.authorityLevel === undefined) {
            return;
        }

        if (value.mode === 'enforced' && value.authorityLevel !== 'enforce') {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['authorityLevel'],
                message:
                    'authorityLevel must be "enforce" when mode is "enforced".',
            });
        }

        if (
            value.mode === 'observe_only' &&
            value.authorityLevel === 'enforce'
        ) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['authorityLevel'],
                message:
                    'authorityLevel cannot be "enforce" when mode is "observe_only".',
            });
        }
    })
    .strict();
// Cross-field execution invariants:
// - skipped/failed must explain why (reasonCode required)
// - executed may include reasonCode for policy outcomes (for example reroutes)
// This keeps telemetry queryable and makes fallback intent auditable.
const ExecutionEventSchema = z
    .object({
        kind: z.enum(['planner', 'evaluator', 'tool', 'generation']),
        status: ExecutionStatusSchema,
        originalProfileId: z.string().min(1).optional(),
        effectiveProfileId: z.string().min(1).optional(),
        profileId: z.string().min(1).optional(),
        provider: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        toolName: z.string().min(1).optional(),
        evaluator: EvaluatorOutcomeSchema.optional(),
        reasonCode: ExecutionReasonCodeSchema.optional(),
        durationMs: z.number().int().nonnegative().optional(),
    })
    .superRefine((value, context) => {
        if (
            (value.status === 'skipped' || value.status === 'failed') &&
            !value.reasonCode
        ) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                    'reasonCode is required when execution status is skipped or failed.',
            });
        }

        if (value.kind === 'tool' && !value.toolName) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'toolName is required when execution kind is tool.',
            });
        }

        if (value.reasonCode) {
            const reasonCodeByKind = {
                planner: PlannerExecutionReasonCodeSchema,
                evaluator: EvaluatorExecutionReasonCodeSchema,
                tool: ToolExecutionReasonCodeSchema,
                generation: GenerationExecutionReasonCodeSchema,
            } as const;
            const reasonCodeSchema = reasonCodeByKind[value.kind];
            const reasonCodeResult = reasonCodeSchema.safeParse(
                value.reasonCode
            );
            if (!reasonCodeResult.success) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `reasonCode "${value.reasonCode}" is not valid for execution kind "${value.kind}".`,
                });
            }
        }
    })
    .strict();

const StepOutcomeSchema = z
    .object({
        status: z.enum(WORKFLOW_STEP_STATUSES),
        summary: z.string().min(1),
        artifacts: z.array(z.string()).optional(),
        signals: z
            .record(
                z.string(),
                z.union([z.string(), z.number(), z.boolean(), z.null()])
            )
            .optional(),
        recommendations: z.array(z.string()).optional(),
    })
    .strict();

const StepRecordSchema = z
    .object({
        stepId: z.string().min(1),
        parentStepId: z.string().min(1).optional(),
        attempt: z.number().int().positive(),
        stepKind: z.enum(WORKFLOW_STEP_KINDS),
        reasonCode: ExecutionReasonCodeSchema.optional(),
        startedAt: z.string().datetime(),
        finishedAt: z.string().datetime(),
        durationMs: z.number().int().nonnegative(),
        model: z.string().min(1).optional(),
        usage: z
            .object({
                promptTokens: z.number().int().nonnegative().optional(),
                completionTokens: z.number().int().nonnegative().optional(),
                totalTokens: z.number().int().nonnegative().optional(),
            })
            .strict()
            .optional(),
        cost: z
            .object({
                inputCostUsd: z.number().nonnegative(),
                outputCostUsd: z.number().nonnegative(),
                totalCostUsd: z.number().nonnegative(),
            })
            .strict()
            .optional(),
        outcome: StepOutcomeSchema,
    })
    .strict();

const WorkflowRecordSchema = z
    .object({
        workflowId: z.string().min(1),
        workflowName: z.string().min(1),
        status: z.enum(['completed', 'degraded']),
        stepCount: z.number().int().nonnegative(),
        maxSteps: z.number().int().positive(),
        maxDurationMs: z.number().int().positive(),
        terminationReason: z.enum(WORKFLOW_TERMINATION_REASONS),
        steps: z.array(StepRecordSchema),
    })
    .superRefine((value, context) => {
        if (value.stepCount !== value.steps.length) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'stepCount must equal steps.length.',
            });
        }

        const seenStepIds = new Set<string>();
        for (const step of value.steps) {
            if (seenStepIds.has(step.stepId)) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `stepId "${step.stepId}" must be unique within a workflow.`,
                });
            }

            if (
                step.parentStepId !== undefined &&
                step.parentStepId === step.stepId
            ) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `stepId "${step.stepId}" cannot self-reference as parentStepId.`,
                });
            }

            seenStepIds.add(step.stepId);
        }

        for (const step of value.steps) {
            if (
                step.parentStepId !== undefined &&
                !seenStepIds.has(step.parentStepId)
            ) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `parentStepId "${step.parentStepId}" must reference a stepId in the same workflow.`,
                });
            }
        }
    })
    .strict();

const TrustGraphProvenanceReasonCodeSchema = z.enum([
    'external_scope_validation_failed',
    'adapter_scope_mismatch',
    'adapter_disabled',
    'adapter_timeout',
    'adapter_timeout_cancellation_requested',
    'adapter_error',
    'adapter_processing_failed',
    'poisoned_evidence_dropped',
    'aggregate_signals_neutralized_after_filtering',
    'ownership_validation_explicitly_none_denied',
    'ownership_validation_explicitly_none_allowed_non_production',
]);

const TrustGraphScopeTupleSchema = z
    .object({
        userId: z.string().min(1),
        projectId: z.string().min(1).optional(),
        collectionId: z.string().min(1).optional(),
    })
    .strict();

const TrustGraphScopeValidationResultSchema = z.discriminatedUnion('ok', [
    z
        .object({
            ok: z.literal(true),
            normalizedScope: TrustGraphScopeTupleSchema,
        })
        .strict(),
    z
        .object({
            ok: z.literal(false),
            reasonCode: z.literal('external_scope_validation_failed'),
            details: z.string().min(1),
        })
        .strict(),
]);

const TrustGraphMetadataSchema = z
    .object({
        adapterStatus: z.enum([
            'off',
            'scope_denied',
            'success',
            'timeout',
            'error',
        ]),
        scopeValidation: TrustGraphScopeValidationResultSchema,
        terminalAuthority: z.literal('backend_execution_contract'),
        failOpenBehavior: z.literal('local_behavior'),
        verificationRequired: z.literal(true),
        advisoryEvidenceItemCount: z.number().int().nonnegative(),
        droppedEvidenceCount: z.number().int().nonnegative(),
        droppedEvidenceIds: z.array(z.string().min(1)),
        provenanceReasonCodes: z.array(TrustGraphProvenanceReasonCodeSchema),
        sufficiencyView: z
            .object({
                coverageValue: z.number().nonnegative().optional(),
                coverageEvaluationUnit: z
                    .enum(['claim', 'subquestion', 'source'])
                    .optional(),
                conflictSignals: z.array(z.string().min(1)),
            })
            .strict(),
        evidenceView: z
            .object({
                sourceRefs: z.array(z.string().min(1)),
                provenancePathRefs: z.array(z.string().min(1)),
                traceRefs: z.array(z.string().min(1)),
            })
            .strict(),
        provenanceJoin: z
            .object({
                externalEvidenceBundleId: z.string().min(1),
                externalTraceRefs: z.array(z.string().min(1)),
                adapterVersion: z.string().min(1),
                consumedGovernedFieldPaths: z.array(z.string().min(1)),
                consumedByConsumers: z.array(z.enum(['P_SUFF', 'P_EVID'])),
                droppedEvidenceIds: z.array(z.string().min(1)),
                reasonCodes: z.array(TrustGraphProvenanceReasonCodeSchema),
            })
            .strict()
            .optional(),
    })
    .strict();

type _AssertTrustGraphMetadata =
    z.infer<typeof TrustGraphMetadataSchema> extends TrustGraphMetadata
        ? TrustGraphMetadata extends z.infer<typeof TrustGraphMetadataSchema>
            ? true
            : false
        : false;
const _assertTrustGraphMetadata: _AssertTrustGraphMetadata = true;
void _assertTrustGraphMetadata;

const ProvenanceAssessmentSchema = z
    .object({
        methodId: z.literal('deterministic_multi_signal_v1'),
        methodLabel: z.string().min(1),
        signals: z
            .object({
                citationsPresent: z.boolean(),
                retrievalRequested: z.boolean(),
                retrievalUsed: z.boolean(),
                retrievalToolExecuted: z.boolean(),
                workflowEvidence: z.boolean(),
                trustGraphEvidenceAvailable: z.boolean(),
                trustGraphEvidenceUsed: z.boolean(),
                assistantDeclaredSpeculative: z.boolean(),
            })
            .strict(),
        conflicts: z.array(z.string().min(1)),
        limitations: z.array(z.string().min(1)),
    })
    .strict();

type _AssertProvenanceAssessment =
    z.infer<typeof ProvenanceAssessmentSchema> extends ProvenanceAssessment
        ? ProvenanceAssessment extends z.infer<
              typeof ProvenanceAssessmentSchema
          >
            ? true
            : false
        : false;
const _assertProvenanceAssessment: _AssertProvenanceAssessment = true;
void _assertProvenanceAssessment;

const WorkflowModeIdSchema = z.enum(['fast', 'balanced', 'grounded']);

const WorkflowModeSelectionSourceSchema = z.enum([
    'requested_mode',
    'inferred_from_execution_contract',
    'fail_open_default',
]);

const WorkflowModeBehaviorSchema = z
    .object({
        executionContractPresetId: z.enum([
            'fast-direct',
            'balanced',
            'quality-grounded',
        ]),
        workflowProfileClass: z.enum(['direct', 'reviewed']),
        workflowProfileId: z.enum(['bounded-review', 'generate-only']),
        workflowExecution: z.enum(['disabled', 'policy_gated', 'always']),
        reviewPass: z.enum(['included', 'excluded']),
        reviseStep: z.enum(['allowed', 'disallowed']),
        evidencePosture: z.enum(['minimal', 'balanced', 'strict']),
        maxWorkflowSteps: z.number().int().positive(),
        maxDeliberationCalls: z.number().int().nonnegative(),
    })
    .strict();

const WorkflowModeDecisionSchema = z
    .object({
        modeId: WorkflowModeIdSchema,
        selectedBy: WorkflowModeSelectionSourceSchema,
        selectionReason: z.string().min(1),
        requestedModeId: z.string().min(1).optional(),
        executionContractResponseMode: z
            .enum(['fast_direct', 'quality_grounded'])
            .optional(),
        behavior: WorkflowModeBehaviorSchema,
    })
    .strict();

const SteerabilityControlIdSchema = z.enum([
    'workflow_mode',
    'evidence_strictness',
    'review_intensity',
    'provider_preference',
    'persona_tone_overlay',
    'tool_allowance',
]);

const SteerabilityControlSourceSchema = z.enum([
    'runtime_config',
    'execution_contract',
    'request_override',
    'planner_output',
    'surface_profile',
    'capability_policy',
    'tool_policy',
    'fail_open_default',
]);

const SteerabilityImpactTargetSchema = z.enum([
    'workflow_execution',
    'execution_contract_selection',
    'review_loop_execution',
    'model_profile_selection',
    'persona_prompt_layer',
    'tool_eligibility',
]);

const SteerabilityControlRecordSchema = z
    .object({
        controlId: SteerabilityControlIdSchema,
        value: z.string().min(1),
        source: SteerabilityControlSourceSchema,
        rationale: z.string().min(1),
        mattered: z.boolean(),
        impactedTargets: z.array(SteerabilityImpactTargetSchema),
    })
    .strict();

const SteerabilityControlsSchema = z
    .object({
        version: z.literal('v1'),
        controls: z.array(SteerabilityControlRecordSchema).min(1),
    })
    .strict();

type _AssertSteerabilityControls =
    z.infer<typeof SteerabilityControlsSchema> extends SteerabilityControls
        ? SteerabilityControls extends z.infer<
              typeof SteerabilityControlsSchema
          >
            ? true
            : false
        : false;
const _assertSteerabilityControls: _AssertSteerabilityControls = true;
void _assertSteerabilityControls;

const responseMetadataShape = {
    responseId: z.string().min(1),
    provenance: ProvenanceSchema,
    safetyTier: SafetyTierSchema,
    tradeoffCount: z.number().nonnegative(),
    chainHash: z.string(),
    licenseContext: z.string(),
    // Deprecated compatibility field; prefer execution[].
    modelVersion: z.string(),
    staleAfter: z.string(),
    totalDurationMs: z.number().int().nonnegative().optional(),
    citations: z.array(CitationSchema),
    provenanceAssessment: ProvenanceAssessmentSchema.optional(),
    execution: z.array(ExecutionEventSchema).optional(),
    workflow: WorkflowRecordSchema.optional(),
    workflowMode: WorkflowModeDecisionSchema.optional(),
    steerabilityControls: SteerabilityControlsSchema.optional(),
    evaluator: EvaluatorOutcomeSchema.optional(),
    imageDescriptions: z.array(z.string()).optional(),
    evidenceScore: TraceAxisScoreSchema.optional(),
    freshnessScore: TraceAxisScoreSchema.optional(),
    temperament: PartialResponseTemperamentSchema.optional(),
    trustGraph: TrustGraphMetadataSchema.optional(),
} as const;

const TraceCardChipDataSchema = z
    .object({
        evidenceScore: TraceAxisScoreSchema.optional(),
        freshnessScore: TraceAxisScoreSchema.optional(),
    })
    .strict();

/**
 * Response metadata is intentionally tolerant so new backend fields do not break clients.
 */
export const ResponseMetadataSchema = z
    .object(responseMetadataShape)
    .passthrough();

/**
 * @api.operationId: postChat
 * @api.path: POST /api/chat
 */
export const PostChatRequestSchema = z
    .object({
        surface: ChatSurfaceSchema,
        botPersonaId: ChatPersonaIdSchema.optional(),
        profileId: ChatProfileIdSchema.optional(),
        generation: z
            .object({
                reasoningEffort: z
                    .enum(['minimal', 'low', 'medium', 'high'])
                    .optional(),
                verbosity: z.enum(['low', 'medium', 'high']).optional(),
            })
            .strict()
            .optional(),
        trigger: z
            .object({
                kind: ChatTriggerKindSchema,
                messageId: z.string().min(1).optional(),
            })
            .strict(),
        latestUserInput: z.string().min(1).max(3072),
        conversation: z.array(ChatConversationMessageSchema).min(1).max(64),
        attachments: z.array(ChatAttachmentSchema).max(8).optional(),
        capabilities: ChatCapabilitiesSchema.optional(),
        sessionId: z.string().min(1).max(128).optional(),
        surfaceContext: z
            .object({
                channelId: z.string().min(1).optional(),
                guildId: z.string().min(1).optional(),
                userId: z.string().min(1).optional(),
                requestHost: z.string().min(1).optional(),
            })
            .strict()
            .optional(),
    })
    .strict();

/**
 * @api.operationId: postChat
 * @api.path: POST /api/chat
 */
export const PostChatResponseSchema = z.discriminatedUnion('action', [
    z
        .object({
            action: z.literal('message'),
            message: z.string(),
            modality: z.enum(['text', 'tts']),
            metadata: ResponseMetadataSchema,
        })
        .passthrough(),
    z
        .object({
            action: z.literal('react'),
            reaction: z.string().min(1),
            metadata: z.null(),
        })
        .passthrough(),
    z
        .object({
            action: z.literal('ignore'),
            metadata: z.null(),
        })
        .passthrough(),
    z
        .object({
            action: z.literal('image'),
            imageRequest: ChatImageRequestSchema,
            metadata: z.null(),
        })
        .passthrough(),
]);

/**
 * @api.operationId: getChatProfiles
 * @api.path: GET /api/chat/profiles
 */
export const GetChatProfilesResponseSchema = z
    .object({
        profiles: z
            .array(
                z
                    .object({
                        id: z.string().min(1),
                        description: z.string().min(1).optional(),
                    })
                    .strict()
            )
            .max(100),
    })
    .strict();

/**
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export const PostInternalNewsTaskRequestSchema = z
    .object({
        task: z.literal('news'),
        query: z.string().min(1).max(512).optional(),
        category: z.string().min(1).max(128).optional(),
        maxResults: z.number().int().min(1).max(5).optional(),
        reasoningEffort: z
            .enum(['minimal', 'low', 'medium', 'high'])
            .optional(),
        verbosity: z.enum(['low', 'medium', 'high']).optional(),
        channelContext: z
            .object({
                channelId: z.string().min(1).optional(),
                guildId: z.string().min(1).optional(),
            })
            .strict()
            .optional(),
    })
    .strict();

/**
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export const PostInternalNewsTaskResponseSchema = z
    .object({
        task: z.literal('news'),
        result: z
            .object({
                news: z.array(InternalNewsItemSchema),
                summary: z.string(),
            })
            .strict(),
    })
    .strict();

/**
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export const PostInternalImageDescriptionTaskRequestSchema = z
    .object({
        task: z.literal('image_description'),
        imageUrl: z.string().url(),
        context: z.string().min(1).max(4096).optional(),
        channelContext: z
            .object({
                channelId: z.string().min(1).optional(),
                guildId: z.string().min(1).optional(),
            })
            .strict()
            .optional(),
    })
    .strict();

/**
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export const PostInternalImageDescriptionTaskResponseSchema = z
    .object({
        task: z.literal('image_description'),
        result: z
            .object({
                description: z.string().min(1),
                model: z.string().min(1),
                usage: z
                    .object({
                        inputTokens: z.number().int().nonnegative(),
                        outputTokens: z.number().int().nonnegative(),
                        totalTokens: z.number().int().nonnegative(),
                    })
                    .strict(),
                costs: z
                    .object({
                        input: z.number().nonnegative(),
                        output: z.number().nonnegative(),
                        total: z.number().nonnegative(),
                    })
                    .strict(),
            })
            .strict(),
    })
    .strict();

/**
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export const PostInternalImageGenerateRequestSchema = z
    .object({
        task: z.literal('generate'),
        prompt: z.string().min(1).max(8000),
        textModel: z.enum(internalImageTextModels),
        imageModel: z.enum(internalImageRenderModels),
        size: z.enum(['1024x1024', '1024x1536', '1536x1024', 'auto']),
        quality: z.enum(['low', 'medium', 'high', 'auto']),
        background: z.enum(['auto', 'transparent', 'opaque']),
        style: z.string().min(1).max(100),
        allowPromptAdjustment: z.boolean(),
        outputFormat: z.enum(supportedImageOutputFormats),
        outputCompression: z.number().int().min(0).max(100),
        user: z
            .object({
                username: z.string().min(1).max(128),
                nickname: z.string().min(1).max(128),
                guildName: z.string().min(1).max(256),
            })
            .strict(),
        followUpResponseId: z.string().min(1).optional(),
        stream: z.boolean().optional(),
        channelContext: z
            .object({
                channelId: z.string().min(1).optional(),
                guildId: z.string().min(1).optional(),
            })
            .strict()
            .optional(),
    })
    .strict();

const InternalImageAnnotationsSchema = z
    .object({
        title: z.string().nullable(),
        description: z.string().nullable(),
        note: z.string().nullable(),
        adjustedPrompt: z.string().nullable().optional(),
    })
    .strict();

/**
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export const PostInternalImageGenerateResponseSchema = z
    .object({
        task: z.literal('generate'),
        result: z
            .object({
                responseId: z.string().min(1).nullable(),
                textModel: z.enum(internalImageTextModels),
                imageModel: z.enum(internalImageRenderModels),
                revisedPrompt: z.string().nullable(),
                finalStyle: z.string().min(1),
                annotations: InternalImageAnnotationsSchema,
                finalImageBase64: z.string().min(1),
                outputFormat: z.enum(supportedImageOutputFormats),
                outputCompression: z.number().int().min(0).max(100),
                usage: z
                    .object({
                        inputTokens: z.number().int().nonnegative(),
                        outputTokens: z.number().int().nonnegative(),
                        totalTokens: z.number().int().nonnegative(),
                        imageCount: z.number().int().nonnegative(),
                    })
                    .strict(),
                costs: z
                    .object({
                        text: z.number().nonnegative(),
                        image: z.number().nonnegative(),
                        total: z.number().nonnegative(),
                        perImage: z.number().nonnegative(),
                    })
                    .strict(),
                generationTimeMs: z.number().int().nonnegative(),
            })
            .strict(),
    })
    .strict();

/**
 * Endpoint-level request union for trusted internal image tasks. This stays
 * narrow on purpose and currently includes the `generate` task only.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export const PostInternalImageRequestSchema = z.discriminatedUnion('task', [
    PostInternalImageGenerateRequestSchema,
]);

/**
 * Endpoint-level response union for trusted internal image tasks.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export const PostInternalImageResponseSchema = z.discriminatedUnion('task', [
    PostInternalImageGenerateResponseSchema,
]);

/**
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export const InternalImageStreamEventSchema = z.discriminatedUnion('type', [
    z
        .object({
            type: z.literal('partial_image'),
            index: z.number().int().nonnegative(),
            base64: z.string().min(1),
        })
        .strict(),
    z
        .object({
            type: z.literal('result'),
            task: z.literal('generate'),
            result: PostInternalImageGenerateResponseSchema.shape.result,
        })
        .strict(),
    z
        .object({
            type: z.literal('error'),
            error: z.string().min(1),
        })
        .strict(),
]);

/**
 * Endpoint-level request union for trusted internal text tasks. This stays
 * narrow on purpose and includes only purpose-built backend helpers.
 *
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export const PostInternalTextRequestSchema = z.discriminatedUnion('task', [
    PostInternalNewsTaskRequestSchema,
    PostInternalImageDescriptionTaskRequestSchema,
]);

/**
 * Endpoint-level response union for trusted internal text tasks.
 *
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export const PostInternalTextResponseSchema = z.discriminatedUnion('task', [
    PostInternalNewsTaskResponseSchema,
    PostInternalImageDescriptionTaskResponseSchema,
]);

/**
 * @api.operationId: postTraces
 * @api.path: POST /api/traces
 */
export const PostTracesRequestSchema = z.object(responseMetadataShape).strict();

/**
 * @api.operationId: postTraces
 * @api.path: POST /api/traces
 */
export const PostTracesResponseSchema = z
    .object({
        ok: z.literal(true),
        responseId: z.string().min(1),
    })
    .passthrough();

/**
 * @api.operationId: postTraceCards
 * @api.path: POST /api/trace-cards
 */
export const PostTraceCardRequestSchema = z
    .object({
        responseId: z.string().min(1).optional(),
        temperament: PartialResponseTemperamentSchema.optional(),
        chips: TraceCardChipDataSchema.optional(),
    })
    .strict();

/**
 * @api.operationId: postTraceCards
 * @api.path: POST /api/trace-cards
 */
export const PostTraceCardResponseSchema = z
    .object({
        responseId: z.string().min(1),
        pngBase64: z.string().min(1),
    })
    .passthrough();

/**
 * @api.operationId: postTraceCardsFromTrace
 * @api.path: POST /api/trace-cards/from-trace
 */
export const PostTraceCardFromTraceRequestSchema = z
    .object({
        responseId: z.string().min(1),
    })
    .strict();

/**
 * @api.operationId: postTraceCardsFromTrace
 * @api.path: POST /api/trace-cards/from-trace
 */
export const PostTraceCardFromTraceResponseSchema = PostTraceCardResponseSchema;

/**
 * @api.operationId: getTrace
 * @api.path: GET /api/traces/{responseId}
 */
export const GetTraceResponseSchema = ResponseMetadataSchema;

/**
 * @api.operationId: getTrace
 * @api.path: GET /api/traces/{responseId}
 */
export const GetTraceStaleResponseSchema = z
    .object({
        message: z.literal('Trace is stale'),
        metadata: ResponseMetadataSchema,
    })
    .passthrough();

/**
 * Trace reads can return either live metadata or a stale envelope depending on status.
 */
export const GetTraceApiResponseSchema = z.union([
    GetTraceResponseSchema,
    GetTraceStaleResponseSchema,
]);

/**
 * Shared API error envelope for normalized server-side error responses.
 */
export const ApiErrorResponseSchema = z
    .object({
        error: z.string(),
        details: z.string().optional(),
        retryAfter: z.number().int().nonnegative().optional(),
    })
    .strict();

const IncidentPointersSchema = z
    .object({
        responseId: z.string().min(1).optional(),
        guildId: z.string().min(1).optional(),
        channelId: z.string().min(1).optional(),
        messageId: z.string().min(1).optional(),
        modelVersion: z.string().min(1).optional(),
        chainHash: z.string().min(1).optional(),
    })
    .strict();

const IncidentAuditEventSchema = z
    .object({
        action: IncidentAuditActionSchema,
        actorHash: z.string().min(1).nullable().optional(),
        notes: z.string().min(1).nullable().optional(),
        createdAt: z.string().datetime(),
    })
    .strict();

const IncidentRemediationSchema = z
    .object({
        state: IncidentRemediationStateSchema,
        applied: z.boolean(),
        notes: z.string().min(1).nullable().optional(),
        updatedAt: z.string().datetime().nullable().optional(),
    })
    .strict();

const IncidentSummarySchema = z
    .object({
        incidentId: z.string().min(1),
        status: IncidentStatusSchema,
        tags: z.array(z.string().min(1)),
        description: z.string().min(1).nullable().optional(),
        contact: z.string().min(1).nullable().optional(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
        consentedAt: z.string().datetime(),
        pointers: IncidentPointersSchema,
        remediation: IncidentRemediationSchema,
    })
    .strict();

const IncidentDetailSchema = IncidentSummarySchema.extend({
    auditEvents: z.array(IncidentAuditEventSchema),
}).strict();

/**
 * @api.operationId: postIncidentReport
 * @api.path: POST /api/incidents/report
 */
export const PostIncidentReportRequestSchema = z
    .object({
        reporterUserId: z.string().min(1),
        guildId: z.string().min(1).optional(),
        channelId: z.string().min(1).optional(),
        messageId: z.string().min(1).optional(),
        jumpUrl: z.string().url().optional(),
        responseId: z.string().min(1).optional(),
        chainHash: z.string().min(1).optional(),
        modelVersion: z.string().min(1).optional(),
        tags: z.array(z.string().min(1)).max(25).optional(),
        description: z.string().trim().min(1).max(2000).optional(),
        contact: z.string().trim().min(1).max(500).optional(),
        consentedAt: z.string().datetime(),
    })
    .strict();

/**
 * @api.operationId: postIncidentReport
 * @api.path: POST /api/incidents/report
 */
export const PostIncidentReportResponseSchema = z
    .object({
        incident: IncidentDetailSchema,
        remediation: z
            .object({
                state: z.literal('pending'),
            })
            .strict(),
    })
    .strict();

/**
 * @api.operationId: listIncidents
 * @api.path: GET /api/incidents
 */
export const GetIncidentsResponseSchema = z
    .object({
        incidents: z.array(IncidentSummarySchema),
    })
    .strict();

/**
 * @api.operationId: getIncident
 * @api.path: GET /api/incidents/{incidentId}
 */
export const GetIncidentResponseSchema = z
    .object({
        incident: IncidentDetailSchema,
    })
    .strict();

/**
 * @api.operationId: postIncidentStatus
 * @api.path: POST /api/incidents/{incidentId}/status
 */
export const PostIncidentStatusRequestSchema = z
    .object({
        status: IncidentStatusSchema,
        actorUserId: z.string().min(1).optional(),
        notes: z.string().max(2000).optional(),
    })
    .strict();

/**
 * @api.operationId: postIncidentStatus
 * @api.path: POST /api/incidents/{incidentId}/status
 */
export const PostIncidentStatusResponseSchema = GetIncidentResponseSchema;

/**
 * @api.operationId: postIncidentNotes
 * @api.path: POST /api/incidents/{incidentId}/notes
 */
export const PostIncidentNotesRequestSchema = z
    .object({
        actorUserId: z.string().min(1).optional(),
        notes: z.string().trim().min(1).max(2000),
    })
    .strict();

/**
 * @api.operationId: postIncidentNotes
 * @api.path: POST /api/incidents/{incidentId}/notes
 */
export const PostIncidentNotesResponseSchema = GetIncidentResponseSchema;

/**
 * @api.operationId: postIncidentRemediation
 * @api.path: POST /api/incidents/{incidentId}/remediation
 */
export const PostIncidentRemediationRequestSchema = z
    .object({
        actorUserId: z.string().min(1).optional(),
        state: z.enum([
            'applied',
            'already_marked',
            'skipped_not_assistant',
            'failed',
        ]),
        notes: z.string().max(2000).optional(),
    })
    .strict();

/**
 * @api.operationId: postIncidentRemediation
 * @api.path: POST /api/incidents/{incidentId}/remediation
 */
export const PostIncidentRemediationResponseSchema = GetIncidentResponseSchema;

const formatSchemaIssues = (error: z.ZodError): string => {
    const firstIssue = error.issues[0];
    if (!firstIssue) {
        return 'Response payload did not match the expected schema.';
    }

    const issuePath =
        firstIssue.path.length > 0 ? firstIssue.path.join('.') : 'body';
    return `${issuePath}: ${firstIssue.message}`;
};

export const createSchemaResponseValidator =
    <TSchema extends z.ZodTypeAny>(schema: TSchema) =>
    (data: unknown): ApiResponseValidationResult<z.output<TSchema>> => {
        const parsed = schema.safeParse(data);
        if (parsed.success) {
            return {
                success: true,
                data: parsed.data,
            };
        }

        return {
            success: false,
            error: formatSchemaIssues(parsed.error),
        };
    };
