/**
 * @description: Shared type surface for backend OpenAI request execution and
 * response metadata assembly seams.
 * @footnote-scope: interface
 * @footnote-module: OpenAIServiceTypes
 * @footnote-risk: medium - Type drift can desynchronize request execution and metadata contracts.
 * @footnote-ethics: medium - Metadata type errors can misstate provenance and TRACE posture.
 */

import type {
    GenerationSearchContextSize,
    GenerationSearchIntent,
    GenerationRequest,
    RuntimeMessage,
} from '@footnote/agent-runtime';
import type {
    Citation,
    ExecutionReasonCode,
    ExecutionStatus,
    EvaluatorOutcome,
    PlannerExecutionApplyOutcome,
    PlannerExecutionContractType,
    PlannerExecutionPurpose,
    PartialResponseTemperament,
    Provenance,
    ResponseMetadata,
    SteerabilityControlId,
    ToolExecutionContext,
    WorkflowRecord,
} from '@footnote/contracts/ethics-core';

// Owns: shared contracts between provider-facing request code and metadata assembly.
// Does not own: provider call behavior, citation parsing, or metadata policy logic.

export type OpenAIUsage = {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
};

export type AssistantUsage = {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
};

export type AssistantResponseMetadata = {
    model: string;
    usage?: AssistantUsage;
    finishReason?: string;
    reasoningEffort?: string;
    verbosity?: string;
    provenance?: Provenance;
    tradeoffCount?: number;
    citations?: Citation[];
    evidenceScore?: ResponseMetadata['evidenceScore'];
    freshnessScore?: ResponseMetadata['freshnessScore'];
};

export type OpenAIResponseMetadata = {
    model: AssistantResponseMetadata['model'];
    usage?: OpenAIUsage;
    finishReason?: AssistantResponseMetadata['finishReason'];
    reasoningEffort?: AssistantResponseMetadata['reasoningEffort'];
    verbosity?: AssistantResponseMetadata['verbosity'];
    provenance?: AssistantResponseMetadata['provenance'];
    tradeoffCount?: AssistantResponseMetadata['tradeoffCount'];
    citations?: AssistantResponseMetadata['citations'];
    evidenceScore?: AssistantResponseMetadata['evidenceScore'];
    freshnessScore?: AssistantResponseMetadata['freshnessScore'];
};

export type GenerateResponseResult = {
    normalizedText: string;
    metadata: OpenAIResponseMetadata;
};

export type GenerateResponseOptions = Pick<
    GenerationRequest,
    'maxOutputTokens' | 'reasoningEffort' | 'verbosity' | 'search'
>;

export interface OpenAIService {
    generateResponse(
        model: string,
        messages: RuntimeMessage[],
        options?: GenerateResponseOptions
    ): Promise<GenerateResponseResult>;
}

export type ResponsesApiInputMessage = {
    role: string;
    type: 'message';
    content:
        | string
        | Array<{
              type: 'input_text';
              text: string;
          }>;
};

export type ResponsesApiOutputText = {
    type?: string;
    text?: string;
    annotations?: Array<{
        type: string;
        url?: string;
        title?: string;
        start_index: number;
        end_index: number;
    }>;
};

export type ResponsesApiOutputItem = {
    type?: string;
    role?: string;
    content?: ResponsesApiOutputText[];
    finish_reason?: string;
};

export type ResponsesApiTool =
    | {
          type: 'web_search';
          search_context_size?: 'low' | 'medium' | 'high';
      }
    | {
          type: 'function';
          name: string;
          description?: string;
          parameters?: Record<string, unknown>;
      };

export type ResponsesApiResponseData = {
    model?: string;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
    };
    output?: ResponsesApiOutputItem[];
    output_text?: string;
};

export type ResponseMetadataRetrievalContext = {
    requested: boolean;
    used: boolean;
    intent?: GenerationSearchIntent;
    contextSize?: GenerationSearchContextSize;
};

export type ResponseMetadataRuntimeContext = {
    modelVersion: string;
    conversationSnapshot: string;
    totalDurationMs?: number;
    // Planner TRACE target posture. This is answer-shape intent metadata,
    // not source-grounding or retrieval truth.
    plannerTemperament?: PartialResponseTemperament;
    retrieval?: ResponseMetadataRetrievalContext;
    trustGraphEvidenceAvailable?: boolean;
    trustGraphEvidenceUsed?: boolean;
    executionContext?: {
        planner?: {
            status: ExecutionStatus;
            reasonCode?: ExecutionReasonCode;
            purpose: PlannerExecutionPurpose;
            contractType: PlannerExecutionContractType;
            applyOutcome: PlannerExecutionApplyOutcome;
            mattered: boolean;
            matteredControlIds: SteerabilityControlId[];
            profileId: string;
            originalProfileId?: string;
            effectiveProfileId?: string;
            provider: string;
            model: string;
            durationMs?: number;
        };
        evaluator?: {
            status: ExecutionStatus;
            reasonCode?: ExecutionReasonCode;
            outcome?: EvaluatorOutcome;
            durationMs?: number;
        };
        generation?: {
            status: ExecutionStatus;
            reasonCode?: ExecutionReasonCode;
            profileId: string;
            originalProfileId?: string;
            effectiveProfileId?: string;
            provider: string;
            model: string;
            durationMs?: number;
        };
        tool?: {
            toolName: ToolExecutionContext['toolName'];
            status: ToolExecutionContext['status'];
            reasonCode?: ToolExecutionContext['reasonCode'];
            durationMs?: ToolExecutionContext['durationMs'];
        };
    };
    workflow?: WorkflowRecord;
    workflowMode?: ResponseMetadata['workflowMode'];
    steerabilityControls?: ResponseMetadata['steerabilityControls'];
};
