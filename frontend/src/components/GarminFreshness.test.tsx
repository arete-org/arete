// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { GarminFreshness } from './GarminFreshness';
import { fetchAPI } from '@/lib/api';
import { qk, invalidateAfterGarminRefresh, invalidateAfterSession } from '@/lib/queryKeys';
import { syncGame } from '@/lib/gamification';

vi.mock('@/lib/api', () => ({ fetchAPI: vi.fn(), strengthApi: {} }));
vi.mock('@/lib/gamification', () => ({ syncGame: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('shows progress outside the live region and announces only the outcome', async () => {
  let finish!: (value: { state: string }) => void;
  vi.mocked(fetchAPI).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(<QueryClientProvider client={client}><GarminFreshness /></QueryClientProvider>);
  // The region exists before the outcome, and the transient check is not announced.
  expect(screen.getByText('Vérification Garmin…')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('');
  await act(async () => { finish({ state: 'partial' }); });
  expect(screen.getByRole('status').textContent).toContain('incomplète');
  expect(screen.queryByText('Vérification Garmin…')).toBeNull();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.health });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.cardioSessions });
  expect(syncGame).not.toHaveBeenCalled();
});

it.each(['fresh', 'disconnected'])('does not invalidate or settle the game after a %s check', async state => {
  vi.mocked(fetchAPI).mockResolvedValue({ state });
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(<QueryClientProvider client={client}><GarminFreshness /></QueryClientProvider>);
  await waitFor(() => expect(screen.queryByText('Vérification Garmin…')).toBeNull());
  expect(screen.getByRole('status').textContent).toBe('');
  expect(invalidate).not.toHaveBeenCalled();
  expect(syncGame).not.toHaveBeenCalled();
});

it('rechecks committed data after a lost response without starting a game write', async () => {
  vi.mocked(fetchAPI).mockRejectedValue(new Error('Connection lost'));
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(<QueryClientProvider client={client}><GarminFreshness /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('indisponible'));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.cardioSessions });
  expect(syncGame).not.toHaveBeenCalled();
});

it.each(['complete', 'partial', 'cooldown', 'failed'])('refreshes data for %s without settling the game', state => {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  invalidateAfterGarminRefresh(client, state);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.health });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.actual() });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.dashboard() });
  expect(syncGame).not.toHaveBeenCalled();
});

it('keeps game settlement for explicit session writes', () => {
  const client = new QueryClient();
  invalidateAfterSession(client);
  expect(syncGame).toHaveBeenCalledExactlyOnceWith(client);
});

it('coalesces foreground events and aborts only the browser request on unmount', async () => {
  vi.mocked(fetchAPI).mockImplementation(() => new Promise(() => {}));
  const view = render(<QueryClientProvider client={new QueryClient()}><GarminFreshness /></QueryClientProvider>);
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(() => expect(fetchAPI).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(fetchAPI).mock.calls[0][1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
