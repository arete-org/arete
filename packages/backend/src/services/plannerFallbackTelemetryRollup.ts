/**
 * @description: Aggregates planner fail-open/fallback telemetry into grouped summary snapshots for operator review.
 * @footnote-scope: core
 * @footnote-module: PlannerFallbackTelemetryRollup
 * @footnote-risk: low - Incorrect counting can reduce observability quality but does not affect runtime behavior.
 * @footnote-ethics: medium - Misclassified fallback events could hide regressions during incident triage.
 */
import type { PostChatRequest } from '@footnote/contracts/web';

export type PlannerSelectionSource = 'request' | 'planner' | 'default';

export type PlannerFallbackReason =
    | 'planner_execution_failed_planner_runtime_error'
    | 'planner_execution_failed_planner_invalid_output'
    | 'planner_execution_failed_unknown'
    | 'request_invalid_or_disabled_profile'
    | 'planner_invalid_or_disabled_profile'
    | 'planner_non_search_profile_rerouted'
    | 'search_dropped_selection_source_guard'
    | 'search_dropped_no_fallback_profile'
    | 'image_action_missing_image_request';

type PlannerFallbackClassification =
    | 'expected_fail_open'
    | 'regression_candidate';

type PlannerFallbackRollupEvent = {
    reason: PlannerFallbackReason;
    surface: PostChatRequest['surface'];
    selectionSource: PlannerSelectionSource;
};

type PlannerFallbackRollupSummary = {
    totalEvents: number;
    byClassification: Record<PlannerFallbackClassification, number>;
    grouped: Array<
        PlannerFallbackRollupEvent & {
            classification: PlannerFallbackClassification;
            count: number;
        }
    >;
};

type PlannerFallbackTelemetryRollup = {
    record: (event: PlannerFallbackRollupEvent) => void;
};

type CreatePlannerFallbackTelemetryRollupOptions = {
    logger: {
        info: (message: string, payload: unknown) => void;
    };
    emitEvery?: number;
};

const FALLBACK_REASON_CLASSIFICATION: Record<
    PlannerFallbackReason,
    PlannerFallbackClassification
> = {
    planner_execution_failed_planner_runtime_error: 'regression_candidate',
    planner_execution_failed_planner_invalid_output: 'regression_candidate',
    planner_execution_failed_unknown: 'regression_candidate',
    request_invalid_or_disabled_profile: 'expected_fail_open',
    planner_invalid_or_disabled_profile: 'regression_candidate',
    planner_non_search_profile_rerouted: 'expected_fail_open',
    search_dropped_selection_source_guard: 'expected_fail_open',
    search_dropped_no_fallback_profile: 'regression_candidate',
    image_action_missing_image_request: 'regression_candidate',
};

const EVENT_KEY_SEPARATOR = '|';

const toEventKey = (event: PlannerFallbackRollupEvent): string =>
    `${event.reason}${EVENT_KEY_SEPARATOR}${event.surface}${EVENT_KEY_SEPARATOR}${event.selectionSource}`;

const fromEventKey = (
    key: string
): PlannerFallbackRollupEvent | undefined => {
    const [reason, surface, selectionSource] = key.split(EVENT_KEY_SEPARATOR);
    if (!reason || !surface || !selectionSource) {
        return undefined;
    }

    return {
        reason: reason as PlannerFallbackReason,
        surface: surface as PostChatRequest['surface'],
        selectionSource: selectionSource as PlannerSelectionSource,
    };
};

const buildSummary = (
    countsByKey: Map<string, number>,
    totalEvents: number
): PlannerFallbackRollupSummary => {
    const byClassification: Record<PlannerFallbackClassification, number> = {
        expected_fail_open: 0,
        regression_candidate: 0,
    };
    const grouped: PlannerFallbackRollupSummary['grouped'] = [];

    for (const [key, count] of countsByKey.entries()) {
        const parsed = fromEventKey(key);
        if (!parsed) {
            continue;
        }

        const classification = FALLBACK_REASON_CLASSIFICATION[parsed.reason];
        byClassification[classification] += count;
        grouped.push({
            ...parsed,
            classification,
            count,
        });
    }

    grouped.sort((left, right) => right.count - left.count);

    return {
        totalEvents,
        byClassification,
        grouped,
    };
};

export const createPlannerFallbackTelemetryRollup = ({
    logger,
    emitEvery = 25,
}: CreatePlannerFallbackTelemetryRollupOptions): PlannerFallbackTelemetryRollup => {
    const normalizedEmitEvery = Number.isInteger(emitEvery) && emitEvery > 0
        ? emitEvery
        : 25;
    const countsByKey = new Map<string, number>();
    let totalEvents = 0;

    const shouldEmit = (eventCount: number): boolean =>
        eventCount === 1 || eventCount % normalizedEmitEvery === 0;

    const record = (event: PlannerFallbackRollupEvent): void => {
        totalEvents += 1;
        const key = toEventKey(event);
        const nextCount = (countsByKey.get(key) ?? 0) + 1;
        countsByKey.set(key, nextCount);

        if (!shouldEmit(totalEvents)) {
            return;
        }

        logger.info('chat.planner.fallback.rollup', {
            ...buildSummary(countsByKey, totalEvents),
            latestEvent: event,
        });
    };

    return {
        record,
    };
};
