// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { tipsApi, type DailyTip } from '@/lib/api';
import { TIP_POLL_DELAYS_MS, useDailyTip } from './dailyTip';

vi.mock('@/lib/api', () => ({ tipsApi: { getDaily: vi.fn(), writeDaily: vi.fn() } }));

const pending: DailyTip = { status: 'pending', tip: null, priority: null, source: null, generated_at: null, updated_after_sync: false };
const ready: DailyTip = { status: 'ready', tip: 'Footing facile.', priority: 'info', source: 'agent', generated_at: '2026-10-13T07:00:00', updated_after_sync: false };

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return renderHook(() => useDailyTip(), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
}

/** Advances the clock, then lets the query's batched notification reach React. */
async function tick(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 13, 8, 0));
  vi.mocked(tipsApi.getDaily).mockReset().mockResolvedValue(pending);
  // The writing request outlives the polling: it never settles here.
  vi.mocked(tipsApi.writeDaily).mockReset().mockReturnValue(new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('asks once for the briefing and shows it when a poll finds it written', async () => {
  const { result } = mount();
  await tick();
  expect(result.current.writing).toBe(true);
  expect(tipsApi.writeDaily).toHaveBeenCalledTimes(1);

  vi.mocked(tipsApi.getDaily).mockResolvedValue(ready);
  await tick(TIP_POLL_DELAYS_MS[0]);
  expect(result.current.tip?.tip).toBe('Footing facile.');
  expect(result.current.writing).toBe(false);
  expect(tipsApi.writeDaily).toHaveBeenCalledTimes(1);
});

it('stops polling after the cap and offers a refresh', async () => {
  const { result } = mount();
  await tick();
  for (const delay of TIP_POLL_DELAYS_MS) {
    expect(result.current.stalled).toBe(false);
    await tick(delay);
  }
  expect(tipsApi.getDaily).toHaveBeenCalledTimes(TIP_POLL_DELAYS_MS.length + 1);
  expect(result.current.stalled).toBe(true);

  await tick(10 * 60_000);
  expect(tipsApi.getDaily).toHaveBeenCalledTimes(TIP_POLL_DELAYS_MS.length + 1);
  expect(tipsApi.writeDaily).toHaveBeenCalledTimes(1);

  vi.mocked(tipsApi.getDaily).mockResolvedValue(ready);
  act(() => result.current.refresh());
  await tick();
  expect(result.current.tip?.tip).toBe('Footing facile.');
});

it('takes the written briefing from the writing request itself', async () => {
  vi.mocked(tipsApi.writeDaily).mockResolvedValue(ready);
  const { result } = mount();
  await tick();
  await tick();
  expect(result.current.tip?.tip).toBe('Footing facile.');
  expect(tipsApi.getDaily).toHaveBeenCalledTimes(1);
});

it('retries a failed writing request only on refresh', async () => {
  vi.mocked(tipsApi.writeDaily).mockRejectedValue(new Error('timeout'));
  const { result } = mount();
  await tick();
  for (const delay of TIP_POLL_DELAYS_MS) await tick(delay);
  expect(tipsApi.writeDaily).toHaveBeenCalledTimes(1);
  act(() => result.current.refresh());
  await tick();
  expect(tipsApi.writeDaily).toHaveBeenCalledTimes(2);
});

it('asks again on refresh when the writing request answered pending', async () => {
  // Another request held the day's claim, and its run may have died since.
  vi.mocked(tipsApi.writeDaily).mockResolvedValue(pending);
  const { result } = mount();
  await tick();
  for (const delay of TIP_POLL_DELAYS_MS) await tick(delay);
  expect(result.current.stalled).toBe(true);
  vi.mocked(tipsApi.writeDaily).mockResolvedValue(ready);
  act(() => result.current.refresh());
  await tick();
  expect(tipsApi.writeDaily).toHaveBeenCalledTimes(2);
  expect(result.current.tip?.tip).toBe('Footing facile.');
});

it('a tab left open overnight asks for the new day and polls afresh', async () => {
  vi.mocked(tipsApi.getDaily).mockResolvedValue(ready);
  const { result, rerender } = mount();
  await tick();
  expect(result.current.tip?.tip).toBe('Footing facile.');
  expect(tipsApi.writeDaily).not.toHaveBeenCalled();

  vi.setSystemTime(new Date(2026, 9, 14, 7, 0));
  vi.mocked(tipsApi.getDaily).mockResolvedValue(pending);
  rerender();
  await tick();
  expect(result.current.writing).toBe(true);
  expect(tipsApi.writeDaily).toHaveBeenCalledTimes(1);
  vi.mocked(tipsApi.getDaily).mockClear();
  for (const delay of TIP_POLL_DELAYS_MS) await tick(delay);
  expect(tipsApi.getDaily).toHaveBeenCalledTimes(TIP_POLL_DELAYS_MS.length);
  expect(result.current.stalled).toBe(true);
});

it('waits for the dashboard to seed the read, then writes and polls from it', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const { result, rerender } = renderHook(({ enabled }) => useDailyTip({ enabled }), {
    initialProps: { enabled: false },
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await tick();
  // The dashboard's request is in flight: the line shows, nothing is asked.
  expect(result.current.writing).toBe(true);
  expect(tipsApi.getDaily).not.toHaveBeenCalled();

  act(() => client.setQueryData(['tip-daily', '2026-10-13'], pending));
  rerender({ enabled: true });
  await tick();
  expect(tipsApi.getDaily).not.toHaveBeenCalled();
  expect(tipsApi.writeDaily).toHaveBeenCalledTimes(1);
  vi.mocked(tipsApi.getDaily).mockResolvedValue(ready);
  await tick(TIP_POLL_DELAYS_MS[0]);
  expect(tipsApi.getDaily).toHaveBeenCalledTimes(1);
  expect(result.current.tip?.tip).toBe('Footing facile.');
});
