/**
 * @description: Shared signal-shaping helpers for workflow routing-chain telemetry and assess hint lineage.
 * @footnote-scope: core
 * @footnote-module: WorkflowEngineRoutingSignals
 * @footnote-risk: low - Signal mapping drift affects observability metadata only.
 * @footnote-ethics: medium - Routing and hint signals support governance interpretation.
 */
import type { RoutingChainAttemptLog } from '../stepRoutingExecutor.js';

export type WorkflowRoutingHintLane =
    | 'openai_first_logic'
    | 'ollama_first_style'
    | 'cheaper_first'
    | 'none';

export type WorkflowRoutingHintConflictResolution = 'logic_over_style';

type StepSignalValue = string | number | boolean | null;

type StepSignals = Record<string, StepSignalValue>;

export const buildRoutingChainSignals = (input: {
    attempts?: RoutingChainAttemptLog[];
    selectedProfileId?: string | null;
    selectedProvider?: string | null;
    selectedModel?: string | null;
    signalKeys?: {
        profileId?: string;
        provider?: string;
        model?: string;
    };
}): StepSignals => {
    if (!Array.isArray(input.attempts)) {
        return {};
    }

    const profileIdKey = input.signalKeys?.profileId ?? 'selectedProfileId';
    const providerKey = input.signalKeys?.provider ?? 'selectedProvider';
    const modelKey = input.signalKeys?.model ?? 'selectedModel';
    const signals: StepSignals = {
        routingChainAttemptCount: input.attempts.length,
        routingChainAttemptsJson: JSON.stringify(input.attempts),
    };

    if (input.selectedProfileId !== undefined) {
        signals[profileIdKey] = input.selectedProfileId;
    }
    if (input.selectedProvider !== undefined) {
        signals[providerKey] = input.selectedProvider;
    }
    if (input.selectedModel !== undefined) {
        signals[modelKey] = input.selectedModel;
    }

    return signals;
};

export const buildAssessRoutingHintSignals = (input: {
    assessRoutingHintsCsv?: string;
    routingHintApplied?: WorkflowRoutingHintLane;
    routingHintConflictResolved?: WorkflowRoutingHintConflictResolution;
}): StepSignals => ({
    ...(input.assessRoutingHintsCsv !== undefined && {
        assessRoutingHintsCsv: input.assessRoutingHintsCsv,
    }),
    routingHintApplied: input.routingHintApplied ?? 'none',
    ...(input.routingHintConflictResolved !== undefined && {
        routingHintConflictResolved: input.routingHintConflictResolved,
    }),
});
