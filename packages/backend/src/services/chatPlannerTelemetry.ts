/**
 * @description: Centralizes structured planner telemetry emission for ingestion outcomes and policy-invalid fallback events.
 * @footnote-scope: utility
 * @footnote-module: ChatPlannerTelemetry
 * @footnote-risk: low - Logging extraction should not alter planner decision behavior or execution routing.
 * @footnote-ethics: medium - Consistent planner telemetry improves operator visibility into governance and fail-open outcomes.
 */
import type { PostChatRequest } from '@footnote/contracts/web';
import type { PlannerNormalizationResult } from './chatPlanner.js';
import { logger } from '../utils/logger.js';

type ChatPlannerExecutionMode = 'structured' | 'text_json';
type PlannerOutputIngestionAttempt = 'initial' | 'expanded';

type LogPlannerPolicyInvalidFallbackInput = {
    normalization: PlannerNormalizationResult;
    mode: ChatPlannerExecutionMode;
    request: Pick<PostChatRequest, 'surface' | 'trigger'>;
    plannerStructuredArguments?: string;
    plannerResponseText?: string;
};

export const logPlannerPolicyInvalidFallback = ({
    normalization,
    mode,
    request,
    plannerStructuredArguments,
    plannerResponseText,
}: LogPlannerPolicyInvalidFallbackInput): void => {
    logger.warn(
        'chat planner returned policy-invalid decision; using fallback telemetry class',
        {
            event: 'chat.planner.fallback',
            plannerMode: mode,
            fallbackFrom: mode,
            fallbackTo: 'safe_default_plan',
            fallbackTier: normalization.fallbackTier,
            correctionCodes: normalization.correctionCodes,
            reasonCode: 'planner_invalid_output',
            failureClass: 'policy_invalid',
            surface: request.surface,
            triggerKind: request.trigger.kind,
            plannerStructuredPreviewPresent:
                mode === 'structured' &&
                plannerStructuredArguments !== undefined,
            plannerStructuredPreviewLength:
                mode === 'structured'
                    ? plannerStructuredArguments?.length
                    : undefined,
            plannerResponseTextLength:
                mode === 'text_json' ? plannerResponseText?.length : undefined,
        }
    );
};

type LogPlannerOutputIngestionInput = {
    normalization: PlannerNormalizationResult;
    mode: ChatPlannerExecutionMode;
    attempt: PlannerOutputIngestionAttempt;
    request: Pick<PostChatRequest, 'surface' | 'trigger'>;
};

export const logPlannerOutputIngestion = ({
    normalization,
    mode,
    attempt,
    request,
}: LogPlannerOutputIngestionInput): void => {
    logger.info('chat planner output ingestion applied', {
        event: 'chat.planner.output_ingestion',
        plannerMode: mode,
        attempt,
        applyOutcome: normalization.applyOutcome,
        fallbackTier: normalization.fallbackTier,
        correctionCodes: normalization.correctionCodes,
        outOfContractFieldCount: normalization.outOfContractFields.length,
        outOfContractFields: normalization.outOfContractFields,
        authorityFieldAttemptCount: normalization.authorityFieldAttempts.length,
        authorityFieldAttempts: normalization.authorityFieldAttempts,
        surface: request.surface,
        triggerKind: request.trigger.kind,
    });
};
