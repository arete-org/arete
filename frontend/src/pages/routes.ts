// Planning and the log load on first visit; hovering or touching their link
// starts the download so the click usually finds the chunk ready.
export const loadPlanningPage = () => import('./QuestLog').then((m) => ({ default: m.PlanningPage }));
export const loadWeekReviewPage = () =>
  import('./planning/WeekReview').then((m) => ({ default: m.WeekReviewPage }));
export const loadLogPage = () => import('./Log').then((m) => ({ default: m.LogPage }));

const PRELOADS: Record<string, () => Promise<unknown>> = {
  '/planning': loadPlanningPage,
  '/log': loadLogPage,
  '/planning/semaine': loadWeekReviewPage,
};

export function preloadRoute(path: string) {
  PRELOADS[path]?.().catch(() => {});
}
