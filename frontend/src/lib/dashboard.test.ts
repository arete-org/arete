import { QueryClient } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { fetchAPI } from './api';
import { coachTodayKey } from './coachToday';
import { fetchDashboard, type Dashboard } from './dashboard';
import { invalidateAfterSession, qk } from './queryKeys';

vi.mock('./api', () => ({ fetchAPI: vi.fn() }));
vi.mock('./gamification', () => ({ syncGame: vi.fn() }));

const day = '2026-10-13';
const board = {
  date: day,
  planned: [{ id: 7 }],
  actual: [{ id: 41 }],
  strength: [{ id: 3 }],
  plan_today: { date: day, decisions: [] },
  next_goal: { id: 2 },
  player_stats: { level: 1 },
  fitness: { ctl: 40 },
  workload: { acwr: 1.1 },
  health: { date: day, readiness_score: 70 },
  garmin_connected: true,
  briefing: { status: 'pending', tip: null },
  coach: { date: day, items: [], remaining: 0, briefing: null },
} as unknown as Dashboard;

beforeEach(() => vi.mocked(fetchAPI).mockReset().mockResolvedValue(board));

it('reads one answer and seeds the queries it replaces', async () => {
  const client = new QueryClient();
  const data = await fetchDashboard(client, day);

  expect(fetchAPI).toHaveBeenCalledTimes(1);
  expect(fetchAPI).toHaveBeenCalledWith('/dashboard');
  expect(client.getQueryData(qk.planned(day, day))).toEqual(board.planned);
  expect(client.getQueryData(qk.actual(day, day))).toEqual(board.actual);
  expect(client.getQueryData(qk.planToday)).toEqual(board.plan_today);
  expect(client.getQueryData(qk.nextGoal)).toEqual(board.next_goal);
  expect(client.getQueryData(qk.playerStats)).toEqual(board.player_stats);
  expect(client.getQueryData(qk.fitness)).toEqual(board.fitness);
  expect(client.getQueryData(qk.workload)).toEqual(board.workload);
  expect(client.getQueryData(qk.healthDaily(day))).toEqual(board.health);
  expect(client.getQueryData([...qk.tipDaily, day])).toEqual(board.briefing);
  expect(client.getQueryData(coachTodayKey)).toEqual(board.coach);
  // The briefing and the coach card keep their own persistence rules.
  expect(data).not.toHaveProperty('briefing');
  expect(data).not.toHaveProperty('coach');
  expect(data.planned).toEqual(board.planned);
});

it('a logged session refreshes the dashboard', () => {
  const client = new QueryClient();
  client.setQueryData(qk.dashboard(day), { date: day });
  invalidateAfterSession(client);
  expect(client.getQueryState(qk.dashboard(day))?.isInvalidated).toBe(true);
});
