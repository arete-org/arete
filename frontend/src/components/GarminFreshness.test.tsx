// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { GarminFreshness } from './GarminFreshness';
import { fetchAPI } from '@/lib/api';

vi.mock('@/lib/api', () => ({ fetchAPI: vi.fn(), strengthApi: {} }));
vi.mock('@/lib/queryKeys', () => ({ invalidateAfterSession: vi.fn(), qk: { syncStatus: ['syncStatus'], health: ['health'], healthStatus: ['healthStatus'], settings: ['settings'] } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('shows progress and invalidates cached data even after a partial import', async () => {
  let finish!: (value: { state: string }) => void;
  vi.mocked(fetchAPI).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(<QueryClientProvider client={client}><GarminFreshness /></QueryClientProvider>);
  expect(screen.getByRole('status').textContent).toContain('Vérification Garmin');
  await act(async () => { finish({ state: 'partial' }); });
  expect(screen.getByRole('status').textContent).toContain('incomplète');
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['health'] });
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
