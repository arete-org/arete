import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { strengthApi } from './api';
import { syncGame } from './gamification';

/**
 * Every react-query key of the app, in one place.
 *
 * Keys are hierarchical: invalidating `['planned']` invalidates every window.
 * Use `invalidateAfterSession` after anything that creates, edits or matches a
 * session — the same data feeds Dashboard, Planning, Log and Analytics.
 */
export const qk = {
  settings: ['settings'] as const,
  /** The dashboard's lazy form curve (lib/formCurve.ts), one per server day. */
  formCurve: (day?: string) => (day ? (['form-curve', day] as const) : (['form-curve'] as const)),
  /** `GET /dashboard`, one per day (lib/dashboard.ts); it seeds the keys of its slices. */
  dashboard: (day?: string) => (day ? (['dashboard', day] as const) : (['dashboard'] as const)),

  planned: (start?: string, end?: string) =>
    start ? (['planned', start, end ?? start] as const) : (['planned'] as const),
  actual: (start?: string, end?: string) =>
    start ? (['actual', start, end ?? start] as const) : (['actual'] as const),
  matchSummary: (start?: string, end?: string) =>
    start ? (['matchSummary', start, end ?? start] as const) : (['matchSummary'] as const),

  strengthSessions: ['strengthSessions'] as const,
  strengthSession: (id: number) => ['strengthSession', id] as const,
  /** Garmin strength activities awaiting their loads. */
  strengthDrafts: ['strengthDrafts'] as const,
  muscleStats: (days?: number) =>
    days ? (['muscleStats', days] as const) : (['muscleStats'] as const),
  garminCandidates: (sessionId: number) => ['garminCandidates', sessionId] as const,
  /** The exercise library (only exercises already logged or created). */
  exercises: ['exercises'] as const,
  /** One exercise's history, records or suggestion; `['strengthProgress']` is all of them. */
  strengthProgress: (id?: number, part?: 'history' | 'records' | 'suggestion') =>
    id == null ? (['strengthProgress'] as const) : (['strengthProgress', id, part] as const),

  cardioSessions: ['cardioSessions'] as const,
  /** One cardio session's page: laps, analysis, streams. */
  sessionDetail: (id?: number) =>
    id == null ? (['sessionDetail'] as const) : (['sessionDetail', id] as const),
  analytics: ['analytics'] as const,
  /** Under `analytics`: a logged session refreshes the year in review too. */
  yearReview: (year: number) => ['analytics', 'year-review', year] as const,
  playerStats: ['player-stats'] as const,
  fitness: ['fitness'] as const,
  workload: ['workload'] as const,
  tipDaily: ['tip-daily'] as const,
  /** The previous days' briefings: read when the athlete opens them, never kept offline. */
  tipHistory: ['tip-history'] as const,

  health: ['garmin-health'] as const,
  healthDaily: (date: string) => ['garmin-health', 'daily', date] as const,
  healthStatus: ['garminHealthStatus'] as const,
  syncStatus: ['syncStatus'] as const,
  stravaStatus: ['stravaStatus'] as const,

  planToday: ['plan', 'today'] as const,
  /** Last week's review and its proposals. */
  weeklyReview: ['weeklyReview'] as const,
  /** « Ma semaine »: the review with its week's numbers. */
  reviewWeek: ['weeklyReview', 'week'] as const,

  /** Race goals: invalidating `goals` refreshes the list, the next race and projections. */
  goals: ['goals'] as const,
  goalList: ['goals', 'list'] as const,
  nextGoal: ['goals', 'next'] as const,
  goalProjection: (id?: number) =>
    id == null ? (['goals', 'projection'] as const) : (['goals', 'projection', id] as const),
  /** The plan a goal would get; a POST that writes nothing. */
  planPreview: (id: number) => ['goals', 'preview', id] as const,
  paces: ['paces'] as const,
  athleteFacts: ['athleteFacts'] as const,

  /** Every athlete and login of the instance (Settings › Administration). */
  adminAccounts: ['admin', 'accounts'] as const,
  adminFeatureFlags: ['admin', 'feature-flags'] as const,

  vapidKey: ['vapidPublicKey'] as const,
  /** This device's Web Push state (lib/push.ts), not a server answer. */
  pushState: ['pushState'] as const,
};

/**
 * The strength-session list Dashboard, Planning and Log share: one request,
 * each page `select`s its slice (today, the week grid, the 10 latest).
 */
export const strengthSessionsQuery = {
  queryKey: qk.strengthSessions,
  queryFn: () => strengthApi.getSessions(200),
};

export const strengthDraftsQuery = {
  queryKey: qk.strengthDrafts,
  queryFn: () => strengthApi.getDrafts(),
};

/** `keys` and the dashboard, whose one answer also carries their data (Garmin state, health, goals). */
export function invalidateWithDashboard(queryClient: QueryClient, ...keys: QueryKey[]): void {
  for (const key of [...keys, qk.dashboard()]) queryClient.invalidateQueries({ queryKey: key });
}

/** Everything that changes when a session is logged, uploaded, synced or matched. */
function invalidateSessionQueries(queryClient: QueryClient): void {
  for (const key of [
    qk.dashboard(),
    ['workout'],
    ['garmin-exports'],
    qk.planned(),
    qk.actual(),
    qk.matchSummary(),
    qk.strengthSessions,
    qk.strengthDrafts,
    qk.muscleStats(),
    qk.exercises,
    qk.strengthProgress(),
    ['strengthRecords'],
    qk.cardioSessions,
    qk.sessionDetail(),
    qk.analytics,
    qk.playerStats,
    qk.fitness,
    qk.workload,
    qk.planToday,
    ['coaching-attention'],
    ['coachToday'],
    ['plan-change-set'],
    qk.goalProjection(),
    qk.formCurve(),
  ]) {
    queryClient.invalidateQueries({ queryKey: key });
  }
}

export function invalidateAfterSession(queryClient: QueryClient): void {
  invalidateSessionQueries(queryClient);
  // An explicit session write settles the RPG and replaces its snapshot.
  syncGame(queryClient);
}

/** Refresh reads may have committed partial work, but must not start another write. */
export function invalidateAfterGarminRefresh(queryClient: QueryClient, state?: string): void {
  if (state && ['running', 'fresh', 'disconnected'].includes(state)) return;
  invalidateSessionQueries(queryClient);
  for (const key of [qk.syncStatus, qk.health, qk.healthStatus, qk.settings]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}
