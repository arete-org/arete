import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let reload: ReturnType<typeof vi.fn>;
let stored: Map<string, string>;
const stale = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'));

async function load() {
  vi.resetModules();
  return import('./chunkReload');
}

beforeEach(() => {
  reload = vi.fn();
  stored = new Map();
  vi.stubGlobal('window', { location: { reload }, addEventListener: vi.fn() });
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) });
});
afterEach(() => vi.unstubAllGlobals());

it('reloads once onto the new build and keeps the fallback meanwhile', async () => {
  const { importChunk } = await load();
  let settled = false;
  void importChunk(stale)().finally(() => { settled = true; });
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(settled).toBe(false);
});

it('surfaces a second failure right after the reload instead of looping', async () => {
  stored.set('arete.chunk-reload', String(Date.now()));
  const { importChunk } = await load();
  await expect(importChunk(stale)()).rejects.toThrow('Failed to fetch');
  expect(reload).not.toHaveBeenCalled();
});

it('never reloads without storage for its loop guard, nor during a coach run', async () => {
  const { holdReloads, importChunk } = await load();
  holdReloads(true);
  await expect(importChunk(stale)()).rejects.toThrow();
  holdReloads(false);
  vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => {} });
  await expect(importChunk(stale)()).rejects.toThrow();
  expect(reload).not.toHaveBeenCalled();
});

it('never reloads offline: the missing chunk is the network, not a new build', async () => {
  vi.stubGlobal('navigator', { onLine: false });
  const { importChunk } = await load();
  await expect(importChunk(stale)()).rejects.toThrow('Failed to fetch');
  expect(reload).not.toHaveBeenCalled();
});

it('reloads once back online after a chunk failed offline', async () => {
  const listeners: Record<string, () => void> = {};
  vi.stubGlobal('window', { location: { reload }, addEventListener: (type: string, listener: () => void) => { listeners[type] = listener; } });
  const online = { onLine: false };
  vi.stubGlobal('navigator', online);
  const { importChunk } = await load();
  await expect(importChunk(stale)()).rejects.toThrow();
  expect(reload).not.toHaveBeenCalled();
  online.onLine = true;
  listeners.online();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
});

it('never waits more than its bound for a worker that does not finish installing', async () => {
  vi.useFakeTimers();
  try {
    const installing = { state: 'installing', addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const registration = { update: vi.fn(async () => {}), waiting: null, installing };
    vi.stubGlobal('navigator', { onLine: true, serviceWorker: { getRegistration: vi.fn(async () => registration) } });
    const { recoverFromStaleBuild } = await load();
    expect(recoverFromStaleBuild()).toBe(true);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('hands over to a version waiting at load once, never during a coach run nor right after a reload', async () => {
  const listeners: Record<string, () => void> = {};
  const worker = { state: 'installed', postMessage: vi.fn(() => listeners.controllerchange?.()) };
  vi.stubGlobal('navigator', {
    onLine: true,
    serviceWorker: { addEventListener: (type: string, listener: () => void) => { listeners[type] = listener; }, removeEventListener: vi.fn() },
  });
  const first = await load();
  first.holdReloads(true);
  expect(first.takeWaitingAtLoad(worker as unknown as ServiceWorker)).toBe(false);
  first.holdReloads(false);
  expect(first.takeWaitingAtLoad(worker as unknown as ServiceWorker)).toBe(true);
  expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  // The reloaded page finds it still waiting (activation failed): the notice, not a loop.
  const second = await load();
  expect(second.takeWaitingAtLoad(worker as unknown as ServiceWorker)).toBe(false);
});
