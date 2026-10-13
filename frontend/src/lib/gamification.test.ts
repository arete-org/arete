import { QueryClient } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { gameApi, gameKey, type Player } from './gamification';
import { invalidateAfterSession } from './queryKeys';

vi.mock('./api', () => ({ strengthApi: {} }));
vi.mock('./documents', () => ({ documentRequest: vi.fn() }));

const settled = { xp: 50, pending: 0 } as Player;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(gameApi, 'sync').mockResolvedValue(settled);
});

it('a session event settles an opted-in RPG with exactly one projection', async () => {
  const client = new QueryClient();
  client.setQueryData(['game-preference'], { enabled: true, opted_in: true, available: true, version: 1 });
  const refetch = vi.spyOn(client, 'invalidateQueries');
  invalidateAfterSession(client);
  await vi.waitFor(() => expect(client.getQueryData(gameKey)).toEqual(settled));
  expect(gameApi.sync).toHaveBeenCalledTimes(1);
  // The snapshot is replaced, not read again.
  expect(refetch.mock.calls.some(([filters]) => filters?.queryKey?.length === 1 && filters.queryKey[0] === 'game')).toBe(false);
});

it('an opted-out athlete sends no projection', () => {
  const client = new QueryClient();
  client.setQueryData(['game-preference'], { enabled: false, opted_in: false, available: true, version: 1 });
  invalidateAfterSession(client);
  expect(gameApi.sync).not.toHaveBeenCalled();
});

it('a failed session-event projection reads the snapshot again, without replaying it', async () => {
  const client = new QueryClient();
  client.setQueryData(['game-preference'], { enabled: true, opted_in: true, available: true, version: 1 });
  vi.mocked(gameApi.sync).mockRejectedValue(new Error('conflict'));
  const refetch = vi.spyOn(client, 'invalidateQueries');
  invalidateAfterSession(client);
  await vi.waitFor(() => expect(refetch).toHaveBeenCalledWith({ queryKey: gameKey }));
  expect(gameApi.sync).toHaveBeenCalledTimes(1);
});
