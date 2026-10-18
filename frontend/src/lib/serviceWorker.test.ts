// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { delete (navigator as { serviceWorker?: unknown }).serviceWorker; vi.resetModules(); });

it('says "at load" for the page’s first look only, not for a watcher mounted later', async () => {
  const waiting = { state: 'installed' };
  const registration = { waiting, installing: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), update: vi.fn() };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(registration), controller: {} } });
  const { watchForUpdate } = await import('./serviceWorker');
  const first = vi.fn();
  watchForUpdate(first);
  await vi.waitFor(() => expect(first).toHaveBeenCalledWith(waiting, true));
  // A remounted notice (a session change, a gate retry) is mid-session.
  const later = vi.fn();
  watchForUpdate(later);
  await vi.waitFor(() => expect(later).toHaveBeenCalledWith(waiting, false));
});
