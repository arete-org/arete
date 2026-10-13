import { dehydrate, QueryClient } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { toLocalISODate } from './dates';
import { PERSIST_DEHYDRATE, shouldPersistQuery } from './queryPersistence';
import lockfile from '../../package-lock.json?raw';

function query(queryKey: unknown[], data: unknown = {}) {
  const client = new QueryClient();
  client.setQueryData(queryKey, data);
  return client.getQueryCache().find({ queryKey })!;
}

it('keeps the dashboard, settings and goals, never documents or coach data', () => {
  for (const key of [['settings'], ['player-stats'], ['goals', 'next'], ['tip-daily'], ['game-preference']])
    expect(shouldPersistQuery(query(key)), JSON.stringify(key)).toBe(true);
  for (const key of [['coach-documents', 't1'], ['agentMemory'], ['admin', 'accounts'], ['workout', 42], ['sessionDetail', 7]])
    expect(shouldPersistQuery(query(key)), JSON.stringify(key)).toBe(false);
});

it('never paints a briefing that was still being written', () => {
  const today = toLocalISODate();
  expect(shouldPersistQuery(query(['tip-daily', today], { status: 'pending' }))).toBe(false);
  expect(shouldPersistQuery(query(['tip-daily', today], { status: 'ready', tip: 'Footing.' }))).toBe(true);
});

it('keeps only the session windows that contain today', () => {
  const today = toLocalISODate();
  expect(shouldPersistQuery(query(['planned', today, today], []))).toBe(true);
  expect(shouldPersistQuery(query(['actual', '2000-01-03', '2999-01-09'], []))).toBe(true);
  expect(shouldPersistQuery(query(['planned', '2000-01-03', '2000-01-09'], []))).toBe(false);
  expect(shouldPersistQuery(query(['planned'], []))).toBe(false);
});

it('never persists a mutation, not even a paused offline upload', () => {
  const client = new QueryClient();
  client.setQueryData(['settings'], {});
  client.getMutationCache().build(client, { mutationKey: ['upload'] }, { isPaused: true, status: 'pending', variables: { name: 'sortie.fit' } } as never);
  expect(dehydrate(client).mutations).toHaveLength(1);
  const persisted = dehydrate(client, PERSIST_DEHYDRATE);
  expect(persisted.mutations).toEqual([]);
  expect(persisted.queries.map(q => q.queryKey)).toEqual([['settings']]);
});

it('the persister shares the app’s query core (one copy in the lockfile)', () => {
  const lock = JSON.parse(lockfile) as { packages: Record<string, unknown> };
  const copies = Object.keys(lock.packages).filter(path => path.endsWith('node_modules/@tanstack/query-core') && !path.includes('@clerk/'));
  expect(copies).toEqual(['node_modules/@tanstack/query-core']);
});
