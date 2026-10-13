import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { fetchAPI } from './api';
import { coachTodayKey } from './coachToday';
import { fetchDashboard, type Dashboard } from './dashboard';
import { invalidateAfterSession, invalidateWithDashboard, qk } from './queryKeys';

vi.mock('./api', () => ({ fetchAPI: vi.fn() }));
vi.mock('./gamification', () => ({ syncGame: vi.fn() }));

const day = '2026-10-13';
const answer = (label: string) =>
  ({
    date: day,
    planned: [{ id: 7 }],
    actual: [],
    strength: [],
    plan_today: { date: day, decisions: [] },
    next_goal: { id: 2 },
    player_stats: { level: 1 },
    fitness: { ctl: 40 },
    workload: { acwr: 1.1 },
    health: null,
    garmin_connected: true,
    briefing: { status: 'pending', tip: null },
    coach: { date: day, items: [], remaining: 0, briefing: { text: label } },
  }) as unknown as Dashboard;
const board = answer('first');

/** A `/dashboard` read that answers when the test says so. */
function deferred() {
  let resolve!: (value: Dashboard) => void;
  vi.mocked(fetchAPI).mockImplementationOnce(() => new Promise((r) => (resolve = r)));
  return (value: Dashboard) => resolve(value);
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const dashboardQuery = (client: QueryClient) =>
  new QueryObserver(client, { queryKey: qk.dashboard(day), queryFn: ({ signal }) => fetchDashboard(client, signal) });

beforeEach(() => {
  vi.mocked(fetchAPI).mockReset().mockResolvedValue(board);
});

it('reads one answer and seeds only the queries still read elsewhere', async () => {
  const client = new QueryClient();
  const signal = new AbortController().signal;
  const data = await fetchDashboard(client, signal);

  expect(fetchAPI).toHaveBeenCalledTimes(1);
  expect(fetchAPI).toHaveBeenCalledWith('/dashboard', { signal });
  expect(client.getQueryData(qk.nextGoal)).toEqual(board.next_goal);
  expect(client.getQueryData(coachTodayKey)).toEqual(board.coach);
  // Under the server's day, the one the briefing hook is given.
  expect(client.getQueryData([...qk.tipDaily, board.date])).toEqual(board.briefing);
  expect(client.getQueryCache().getAll()).toHaveLength(3);
  // The briefing and the coach card keep their own persistence rules.
  expect(data).not.toHaveProperty('briefing');
  expect(data).not.toHaveProperty('coach');
  expect(data.planned).toEqual(board.planned);
});

it('an answer written after the read started wins over its seed', async () => {
  const client = new QueryClient();
  const answerWith = deferred();
  const read = fetchDashboard(client, new AbortController().signal);
  await new Promise((r) => setTimeout(r, 2));
  client.setQueryData(coachTodayKey, { written: 'by a mutation' });
  answerWith(board);
  await read;
  expect(client.getQueryData(coachTodayKey)).toEqual({ written: 'by a mutation' });
  expect(client.getQueryData(qk.nextGoal)).toEqual(board.next_goal);
});

it('a read replaced by a newer one seeds nothing when it answers last', async () => {
  const client = new QueryClient();
  const unsubscribe = dashboardQuery(client).subscribe(() => {});
  await settle();
  // A focus refresh starts a slow read, then a write's invalidation replaces it.
  const answerSlow = deferred();
  void client.invalidateQueries({ queryKey: qk.dashboard() });
  await settle();
  const answerNew = deferred();
  const refetch = client.invalidateQueries({ queryKey: qk.dashboard() });
  await settle();
  answerNew(answer('new'));
  await refetch;
  answerSlow(answer('slow'));
  await settle();
  expect(client.getQueryData(coachTodayKey)).toEqual(answer('new').coach);
  unsubscribe();
});

it('a cache cleared during the read (sign-out, another account) stays empty', async () => {
  const client = new QueryClient();
  const answerWith = deferred();
  const unsubscribe = dashboardQuery(client).subscribe(() => {});
  await settle();
  unsubscribe();
  client.clear();
  answerWith(board);
  await settle();
  expect(client.getQueryCache().getAll()).toEqual([]);
});

it('a logged session, the Garmin state or a goal refreshes the dashboard', () => {
  const client = new QueryClient();
  client.setQueryData(qk.dashboard(day), { date: day });
  invalidateAfterSession(client);
  expect(client.getQueryState(qk.dashboard(day))?.isInvalidated).toBe(true);

  client.setQueryData(qk.dashboard(day), { date: day });
  client.setQueryData(['syncStatus'], {});
  invalidateWithDashboard(client, ['syncStatus']);
  expect(client.getQueryState(qk.dashboard(day))?.isInvalidated).toBe(true);
  expect(client.getQueryState(['syncStatus'])?.isInvalidated).toBe(true);
});
