import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { fetchAPI, type DailyTip, type garminHealthApi } from './api';
import { coachTodayKey, type CoachToday } from './coachToday';
import { qk } from './queryKeys';
import type {
  ActualSession, FitnessMetrics, Goal, PlannedSession, PlanToday, PlayerStats, StrengthSession, WorkloadMetrics,
} from '@/types';

/** `GET /dashboard`: each field is what its former endpoint answers for `date`, the athlete's today. */
export interface Dashboard {
  date: string;
  planned: PlannedSession[];
  actual: ActualSession[];
  /** Today's rows of `/strength/sessions`. */
  strength: StrengthSession[];
  plan_today: PlanToday;
  next_goal: Goal | null;
  player_stats: PlayerStats;
  fitness: FitnessMetrics;
  workload: WorkloadMetrics;
  /** Null where `/garmin/health/daily` answers 404. */
  health: Awaited<ReturnType<typeof garminHealthApi.getDaily>> | null;
  garmin_connected: boolean;
  /** Any load ever logged: the form curve has something to draw (rounded CTL/ATL can read 0). */
  has_load: boolean;
  briefing: DailyTip;
  coach: CoachToday;
}

/** What the dashboard query keeps: the briefing and the coach card live under their own keys. */
export type DashboardData = Omit<Dashboard, 'briefing' | 'coach'>;

/** Seeds `key` as of `at`, when the read started: an answer written since (a mutation, the key's own read) wins. */
function seed(client: QueryClient, key: QueryKey, data: unknown, at: number) {
  if ((client.getQueryState(key)?.dataUpdatedAt ?? 0) >= at) return;
  client.setQueryData(key, data, { updatedAt: at });
}

/**
 * The dashboard's one request. Its slices also seed the queries that still
 * read them elsewhere: the next goal (Planning), the coach card and the
 * day's briefing (keyed by the server's day). A read cancelled or replaced
 * meanwhile, or whose cache was cleared (sign-out, another account), seeds
 * nothing.
 */
export async function fetchDashboard(client: QueryClient, signal?: AbortSignal): Promise<DashboardData> {
  const started = Date.now();
  const { briefing, coach, ...board } = await fetchAPI<Dashboard>('/dashboard', { signal });
  if (signal?.aborted) return board;
  seed(client, qk.nextGoal, board.next_goal, started);
  seed(client, coachTodayKey, coach, started);
  seed(client, [...qk.tipDaily, board.date], briefing, started);
  return board;
}
