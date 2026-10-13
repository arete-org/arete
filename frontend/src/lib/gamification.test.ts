// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { gameApi, gameKey, useGamePreference, type Player } from './gamification';
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

it('a window focus within five minutes does not refetch the game preference', async () => {
  const preference = vi.spyOn(gameApi, 'preference').mockResolvedValue({ enabled: true, opted_in: true, available: true, version: 1 });
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  renderHook(() => [useGamePreference(), useGamePreference()], { wrapper });
  await waitFor(() => expect(preference).toHaveBeenCalledTimes(1));
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(preference).toHaveBeenCalledTimes(1);
  focusManager.setFocused(undefined);
});
