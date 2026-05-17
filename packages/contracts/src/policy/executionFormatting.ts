/**
 * @description: Shared execution timeline formatting for web and Discord provenance surfaces.
 * @footnote-scope: interface
 * @footnote-module: ExecutionTimelineFormatting
 * @footnote-risk: low - Formatting mistakes may confuse operator visibility but do not affect runtime behavior.
 * @footnote-ethics: medium - Clear execution rendering supports transparency across user-facing surfaces.
 */
import type { ExecutionEvent, StepRecord, WorkflowRecord } from './types.js';

type TimelineEntry = {
    segment: string;
    phaseOrder: 0 | 1 | 2;
    index: number;
};

const formatEvaluatorSummary = (event: ExecutionEvent): string => {
    if (event.kind !== 'evaluator') {
        return 'decision';
    }

    const rawEvaluator = event.evaluator as
        | {
              authorityLevel?: string;
              mode?: string;
              provenance?: string;
              safetyDecision?: {
                  action?: string;
                  safetyTier?: string;
                  ruleId?: string | null;
                  reasonCode?: string;
              };
          }
        | undefined;
    if (!rawEvaluator) {
        return 'decision';
    }

    const safetyDecision = rawEvaluator.safetyDecision;
    if (
        safetyDecision &&
        typeof safetyDecision.action === 'string' &&
        typeof safetyDecision.safetyTier === 'string'
    ) {
        const evaluatorAuthorityLevel =
            typeof rawEvaluator.authorityLevel === 'string'
                ? rawEvaluator.authorityLevel
                : rawEvaluator.mode === 'enforced'
                  ? 'enforce'
                  : safetyDecision.action !== 'allow'
                    ? 'influence'
                    : 'observe';
        return [
            evaluatorAuthorityLevel,
            safetyDecision.safetyTier,
            rawEvaluator.provenance,
            safetyDecision.action,
            ...(safetyDecision.action !== 'allow'
                ? [safetyDecision.ruleId, safetyDecision.reasonCode]
                : []),
        ]
            .filter((part): part is string => !!part)
            .join('/');
    }

    return 'decision';
};

const formatExecutionEvent = (event: ExecutionEvent): string => {
    const durationSuffix =
        event.durationMs !== undefined ? `, ${event.durationMs}ms` : '';
    const reasonSuffix =
        event.status === 'executed' || !event.reasonCode
            ? ''
            : `, ${event.reasonCode}`;
    if (event.kind === 'tool') {
        const tool = event.toolName?.trim() || 'tool';
        return `${event.kind}:${tool}(${event.status}${reasonSuffix}${durationSuffix})`;
    }
    if (event.kind === 'evaluator') {
        const evaluatorSummary = formatEvaluatorSummary(event);
        return `${event.kind}:${evaluatorSummary}(${event.status}${reasonSuffix}${durationSuffix})`;
    }

    // Prefer model first because that is the most user-visible execution
    // identifier. Fall back to profile/provider ids for partial traces.
    const modelOrProfile =
        event.model ??
        event.effectiveProfileId ??
        event.profileId ??
        event.originalProfileId ??
        event.provider ??
        'unknown';
    return `${event.kind}:${modelOrProfile}(${event.status}${reasonSuffix}${durationSuffix})`;
};

const formatWorkflowStep = (
    label: string,
    step: StepRecord,
    defaultModelOrProfile: string
): string => {
    const durationSuffix =
        step.durationMs !== undefined ? `, ${step.durationMs}ms` : '';
    const reasonSuffix =
        step.outcome.status === 'executed' || !step.reasonCode
            ? ''
            : `, ${step.reasonCode}`;
    const profileIdSignal = step.outcome.signals?.profileId;
    const modelOrProfile =
        step.model ??
        (typeof profileIdSignal === 'string' &&
        profileIdSignal.trim().length > 0
            ? profileIdSignal
            : defaultModelOrProfile);
    return `${label}:${modelOrProfile}(${step.outcome.status}${reasonSuffix}${durationSuffix})`;
};

const isIncludedWorkflowStep = (step: StepRecord): boolean =>
    step.stepKind === 'plan' ||
    step.stepKind === 'assess' ||
    (step.stepKind === 'generate' &&
        step.outcome.signals?.refinementApplied === true);

const normalizeWorkflowStepEntry = (
    step: StepRecord,
    index: number
): TimelineEntry | null => {
    if (!isIncludedWorkflowStep(step)) {
        return null;
    }

    if (step.stepKind === 'plan') {
        return {
            segment: formatWorkflowStep('planner', step, 'workflow'),
            phaseOrder: 0,
            index,
        };
    }

    return {
        segment: formatWorkflowStep(step.stepKind, step, 'workflow'),
        phaseOrder: 2,
        index,
    };
};

const normalizeExecutionEventEntry = (
    event: ExecutionEvent,
    index: number
): TimelineEntry | null => {
    if (event.kind === 'planner') {
        return null;
    }

    return {
        segment: formatExecutionEvent(event),
        phaseOrder: 1,
        index,
    };
};

/**
 * Formats execution[] into a compact one-line summary.
 */
export const formatExecutionTimelineSummary = (
    execution: ExecutionEvent[] | undefined,
    workflow?: WorkflowRecord
): string | null => {
    const workflowEntries =
        workflow?.steps
            .map((step, index) => normalizeWorkflowStepEntry(step, index))
            .filter((entry): entry is TimelineEntry => entry !== null) ?? [];
    const executionEntries =
        (execution ?? [])
            .map((event, index) => normalizeExecutionEventEntry(event, index))
            .filter((entry): entry is TimelineEntry => entry !== null) ?? [];
    const timelineSegments = [...workflowEntries, ...executionEntries]
        .sort((left, right) =>
            left.phaseOrder === right.phaseOrder
                ? left.index - right.index
                : left.phaseOrder - right.phaseOrder
        )
        .map((entry) => entry.segment);

    if (timelineSegments.length === 0) {
        return null;
    }

    return timelineSegments.join(' -> ');
};
