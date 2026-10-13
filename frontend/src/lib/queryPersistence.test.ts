import { QueryClient } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { toLocalISODate } from './dates';
import { shouldPersistQuery } from './queryPersistence';

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

it('keeps only the session windows that contain today', () => {
  const today = toLocalISODate();
  expect(shouldPersistQuery(query(['planned', today, today], []))).toBe(true);
  expect(shouldPersistQuery(query(['actual', '2000-01-03', '2999-01-09'], []))).toBe(true);
  expect(shouldPersistQuery(query(['planned', '2000-01-03', '2000-01-09'], []))).toBe(false);
  expect(shouldPersistQuery(query(['planned'], []))).toBe(false);
});
