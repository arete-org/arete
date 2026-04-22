/**
 * @description: Derives a conservative, backend-signal-only run outcome summary for trace rendering.
 * @footnote-scope: utility
 * @footnote-module: TraceOutcomeSummary
 * @footnote-risk: medium - Misclassification could mislead operators about runtime path semantics.
 * @footnote-ethics: high - Outcome summaries influence user trust in transparency and governance behavior.
 */

import type {
    ExecutionEvent,
    ResponseMetadata,
    WorkflowRecord,
    WorkflowTerminationReason,
} from '@footnote/contracts/ethics-core';

type RunOutcomeCategory =
    | 'completed'
    | 'stopped'
    | 'skipped'
    | 'fell_back'
    | 'unknown';

export type RunOutcomeSummary = {
    category: RunOutcomeCategory;
    headline: string;
    explanation: string;
    reasonCode?: string;
    secondaryReasonCode?: string;
};

type TraceOutcomeSource = Pick<ResponseMetadata, 'workflow' | 'execution'>;

const STOP_REASON_EXPLANATIONS: Record<WorkflowTerminationReason, string> = {
    goal_satisfied: 'Workflow reached its goal-satisfied termination path.',
    budget_exhausted_steps:
        'Workflow stopped after reaching the configured step budget.',
    budget_exhausted_tokens:
        'Workflow stopped after reaching the configured token budget.',
    budget_exhausted_time:
        'Workflow stopped after reaching the configured time budget.',
    transition_blocked_by_policy:
        'Workflow stopped because a policy transition check blocked the next step.',
    max_tool_calls_reached:
        'Workflow stopped after reaching the configured tool-call limit.',
    max_deliberation_calls_reached:
        'Workflow stopped after reaching the configured deliberation-call limit.',
    executor_error_fail_open:
        'Workflow recorded an executor error and terminated in fail-open mode.',
};

const FALLBACK_REASON_EXPLANATIONS: Record<string, string> = {
    search_rerouted_to_fallback_profile:
        'Search execution was rerouted to a fallback profile.',
    planner_contract_fallback:
        'Planner execution used the fallback contract path.',
};

const SKIPPED_REASON_EXPLANATIONS: Record<string, string> = {
    search_not_supported_by_selected_profile:
        'A search step was skipped because the selected profile does not support search.',
    tool_not_requested:
        'A tool step was skipped because no tool was requested.',
    tool_not_used:
        'A tool step was skipped because requested tool usage was not applied.',
    search_reroute_not_permitted_by_selection_source:
        'Search reroute was skipped because selection-source policy did not permit rerouting.',
    search_reroute_no_tool_capable_fallback_available:
        'Search reroute was skipped because no tool-capable fallback profile was available.',
    tool_unavailable:
        'A tool step was skipped because the tool was unavailable.',
};

const STOPPED_EXECUTION_REASON_EXPLANATIONS: Record<string, string> = {
    planner_runtime_error: 'Planner execution failed at runtime.',
    planner_invalid_output:
        'Planner output was invalid and could not be applied directly.',
    evaluator_runtime_error: 'Evaluator execution failed at runtime.',
    generation_runtime_error: 'Generation execution failed at runtime.',
    tool_execution_error: 'A tool execution failed at runtime.',
    tool_timeout: 'A tool execution timed out.',
    tool_http_error: 'A tool execution failed with an HTTP error.',
    tool_network_error: 'A tool execution failed with a network error.',
    tool_invalid_response: 'A tool execution returned an invalid response.',
};

const isFallbackPlannerEvent = (event: ExecutionEvent): boolean =>
    event.kind === 'planner' && event.contractType === 'fallback';

const isFallbackPlanStep = (workflow: WorkflowRecord | undefined): boolean =>
    (workflow?.steps ?? []).some(
        (step) =>
            step.stepKind === 'plan' &&
            step.outcome.signals?.contractType === 'fallback'
    );

const isKnownFallbackReason = (reasonCode: string): boolean =>
    reasonCode === 'search_rerouted_to_fallback_profile';

const isKnownSkippedReason = (reasonCode: string): boolean =>
    reasonCode in SKIPPED_REASON_EXPLANATIONS;

const isKnownStoppedExecutionReason = (reasonCode: string): boolean =>
    reasonCode in STOPPED_EXECUTION_REASON_EXPLANATIONS;

export const buildRunOutcomeSummary = (
    source: TraceOutcomeSource
): RunOutcomeSummary | null => {
    const workflow = source.workflow;
    const execution = source.execution ?? [];

    const terminationReason = workflow?.terminationReason;
    const fallbackReasonCodes = new Set<string>();
    const skippedReasonCodes = new Set<string>();
    const failedReasonCodes = new Set<string>();

    for (const event of execution) {
        if (event.status === 'skipped' && event.reasonCode) {
            skippedReasonCodes.add(event.reasonCode);
        }
        if (event.status === 'failed' && event.reasonCode) {
            failedReasonCodes.add(event.reasonCode);
        }
        if (event.reasonCode && isKnownFallbackReason(event.reasonCode)) {
            fallbackReasonCodes.add(event.reasonCode);
        }
        if (isFallbackPlannerEvent(event)) {
            fallbackReasonCodes.add('planner_contract_fallback');
        }
    }

    if (isFallbackPlanStep(workflow)) {
        fallbackReasonCodes.add('planner_contract_fallback');
    }

    const primaryFallbackReason = Array.from(fallbackReasonCodes)[0];
    const primarySkippedReason =
        Array.from(skippedReasonCodes).find(isKnownSkippedReason);
    const primaryFailedReason = Array.from(failedReasonCodes).find(
        isKnownStoppedExecutionReason
    );
    const hasExecutedGeneration = execution.some(
        (event) => event.kind === 'generation' && event.status === 'executed'
    );

    if (terminationReason && terminationReason !== 'goal_satisfied') {
        const stopExplanation =
            STOP_REASON_EXPLANATIONS[terminationReason] ??
            'Workflow terminated before a goal-satisfied completion path.';
        const fallbackSuffix = primaryFallbackReason
            ? ` A fallback signal was also recorded (${primaryFallbackReason}).`
            : '';
        return {
            category: 'stopped',
            headline: 'Stopped',
            explanation: `${stopExplanation}${fallbackSuffix}`,
            reasonCode: terminationReason,
            secondaryReasonCode: primaryFallbackReason,
        };
    }

    if (primaryFallbackReason) {
        return {
            category: 'fell_back',
            headline: 'Fell back',
            explanation:
                FALLBACK_REASON_EXPLANATIONS[primaryFallbackReason] ??
                'Fallback path signals are present in execution metadata.',
            reasonCode: primaryFallbackReason,
        };
    }

    if (primarySkippedReason) {
        return {
            category: 'skipped',
            headline: 'Skipped',
            explanation:
                SKIPPED_REASON_EXPLANATIONS[primarySkippedReason] ??
                'One or more steps were skipped by runtime policy or capability constraints.',
            reasonCode: primarySkippedReason,
        };
    }

    if (terminationReason === 'goal_satisfied' || hasExecutedGeneration) {
        return {
            category: 'completed',
            headline: 'Completed',
            explanation:
                terminationReason === 'goal_satisfied'
                    ? STOP_REASON_EXPLANATIONS.goal_satisfied
                    : 'Execution reached a generation step without an explicit workflow termination record.',
            reasonCode: terminationReason,
        };
    }

    if (primaryFailedReason) {
        return {
            category: 'stopped',
            headline: 'Stopped',
            explanation:
                STOPPED_EXECUTION_REASON_EXPLANATIONS[primaryFailedReason] ??
                'Runtime failure signals were recorded in execution metadata.',
            reasonCode: primaryFailedReason,
        };
    }

    if (workflow || execution.length > 0) {
        return {
            category: 'unknown',
            headline: 'Outcome not fully recorded',
            explanation:
                'Execution metadata exists, but no canonical completion, stop, skip, or fallback reason was recorded.',
        };
    }

    return null;
};
