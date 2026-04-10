/**
 * @description: Coordinates deterministic safety evaluation with fail-open
 * behavior and normalized execution telemetry shape.
 * @footnote-scope: core
 * @footnote-module: ChatOrchestratorEvaluatorCoordination
 * @footnote-risk: medium - Incorrect evaluator wiring can distort safety telemetry and runtime diagnostics.
 * @footnote-ethics: high - Safety decision interpretation affects user protection and governance signaling.
 */
import type {
    ExecutionReasonCode,
    ExecutionStatus,
    EvaluatorAuthorityLevel,
    EvaluatorDecisionMode,
    EvaluatorOutcome,
    SafetyEvaluationInput,
    SafetyTier,
} from '@footnote/contracts/ethics-core';
import type { PostChatRequest } from '@footnote/contracts/web';
import {
    buildSafetyDecision,
    computeProvenance,
    evaluateSafetyDeterministic,
} from '../../ethics-core/evaluators.js';
import { buildCorrelationIds } from './requestNormalization.js';

export type EvaluatorExecutionContext = {
    status: ExecutionStatus;
    reasonCode?: ExecutionReasonCode;
    outcome?: EvaluatorOutcome;
    durationMs: number;
};

const resolveEvaluatorAuthority = (
    safetyAction: EvaluatorOutcome['safetyDecision']['action'],
    mode: EvaluatorDecisionMode
): EvaluatorAuthorityLevel => {
    if (mode === 'enforced') {
        return 'enforce';
    }

    return safetyAction === 'allow' ? 'observe' : 'influence';
};

export const runDeterministicEvaluator = (
    input: {
        normalizedConversation: PostChatRequest['conversation'];
        normalizedRequest: PostChatRequest;
        startedAtMs: number;
    },
    onWarn: {
        warn: (message: string, meta?: Record<string, unknown>) => void;
    }
): {
    evaluatorExecutionContext: EvaluatorExecutionContext;
    evaluatorSafetyTierHint: SafetyTier | undefined;
} => {
    try {
        const evaluatorContext = input.normalizedConversation.map(
            (message) => message.content
        );
        const safetyEvaluationInput: SafetyEvaluationInput = {
            latestUserInput: input.normalizedRequest.latestUserInput,
            conversation: input.normalizedConversation,
        };
        const safetyEvaluation = evaluateSafetyDeterministic(
            safetyEvaluationInput
        );
        const safetyDecision = buildSafetyDecision(safetyEvaluation);
        const mode: EvaluatorDecisionMode = 'observe_only';
        const evaluatorOutcome: EvaluatorOutcome = {
            authorityLevel: resolveEvaluatorAuthority(
                safetyDecision.action,
                mode
            ),
            mode,
            provenance: computeProvenance(evaluatorContext),
            safetyDecision,
        };
        if (evaluatorOutcome.safetyDecision.action !== 'allow') {
            onWarn.warn(
                'deterministic breaker signaled a non-allow action in influence authority',
                {
                    event: 'chat.orchestration.breaker_signal',
                    authorityLevel: evaluatorOutcome.authorityLevel,
                    mode: evaluatorOutcome.mode,
                    action: evaluatorOutcome.safetyDecision.action,
                    ruleId: evaluatorOutcome.safetyDecision.ruleId,
                    reasonCode: evaluatorOutcome.safetyDecision.reasonCode,
                    reason: evaluatorOutcome.safetyDecision.reason,
                    safetyTier: evaluatorOutcome.safetyDecision.safetyTier,
                    surface: input.normalizedRequest.surface,
                    triggerKind: input.normalizedRequest.trigger.kind,
                    correlation: buildCorrelationIds(input.normalizedRequest),
                }
            );
        }

        return {
            evaluatorExecutionContext: {
                status: 'executed',
                outcome: evaluatorOutcome,
                durationMs: Math.max(0, Date.now() - input.startedAtMs),
            },
            evaluatorSafetyTierHint: evaluatorOutcome.safetyDecision.safetyTier,
        };
    } catch (error) {
        onWarn.warn(
            'deterministic evaluator failed open; continuing without evaluator outcome',
            {
                error: error instanceof Error ? error.message : String(error),
            }
        );
        return {
            evaluatorExecutionContext: {
                status: 'failed',
                reasonCode: 'evaluator_runtime_error',
                durationMs: Math.max(0, Date.now() - input.startedAtMs),
            },
            evaluatorSafetyTierHint: undefined,
        };
    }
};
