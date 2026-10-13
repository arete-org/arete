import type { QueryClient } from '@tanstack/react-query';
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
  briefing: DailyTip;
  coach: CoachToday;
}

/** What the dashboard query keeps: the briefing and the coach card live under their own keys. */
export type DashboardData = Omit<Dashboard, 'briefing' | 'coach'>;

/**
 * The dashboard's one request. Its slices also seed the queries they replace,
 * so other pages, the coach card and the briefing's polling start from this
 * answer; `day` is the browser's date the briefing query is keyed by.
 */
export async function fetchDashboard(client: QueryClient, day: string): Promise<DashboardData> {
  const { briefing, coach, ...board } = await fetchAPI<Dashboard>('/dashboard');
  const date = board.date;
  client.setQueryData(qk.planned(date, date), board.planned);
  client.setQueryData(qk.actual(date, date), board.actual);
  client.setQueryData(qk.planToday, board.plan_today);
  client.setQueryData(qk.nextGoal, board.next_goal);
  client.setQueryData(qk.playerStats, board.player_stats);
  client.setQueryData(qk.fitness, board.fitness);
  client.setQueryData(qk.workload, board.workload);
  if (board.health) client.setQueryData(qk.healthDaily(date), board.health);
  client.setQueryData([...qk.tipDaily, day], briefing);
  client.setQueryData(coachTodayKey, coach);
  return board;
}
