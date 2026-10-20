// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyTheme, initializeTheme, normalizeThemePreference, resolveTheme } from './theme';

const KEY = 'arete.theme.v1';

/** A device whose colour scheme the test can flip, like the OS setting. */
function device(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: dark,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => query));
  return {
    listeners,
    flip(next: boolean) {
      query.matches = next;
      listeners.forEach((listener) => listener());
    },
  };
}

const shown = () => document.documentElement.dataset.theme;

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = '<meta name="theme-color" content="#000000">';
});

afterEach(() => {
  applyTheme('pierre');
  vi.unstubAllGlobals();
});

it('maps every retired theme to its closest kept palette, once and for all', () => {
  expect(normalizeThemePreference('light')).toBe('pierre');
  expect(normalizeThemePreference('performance')).toBe('pierre');
  expect(normalizeThemePreference('dark')).toBe('encre');
  expect(normalizeThemePreference('darker')).toBe('encre');
  expect(normalizeThemePreference('abyss')).toBe('encre');
  for (const kept of ['system', 'pierre', 'prune', 'odyssey', 'encre']) expect(normalizeThemePreference(kept)).toBe(kept);
  expect(normalizeThemePreference('unknown')).toBe('system');
  expect(normalizeThemePreference(undefined)).toBe('system');
});

it('resolves « Système » to Pierre in light mode and Encre in dark mode', () => {
  expect(resolveTheme('system', false)).toBe('pierre');
  expect(resolveTheme('system', true)).toBe('encre');
  expect(resolveTheme('prune', true)).toBe('prune');
});

it('follows the device by default in a fresh browser, including a later switch', () => {
  const os = device(true);
  initializeTheme();
  expect(shown()).toBe('encre');
  expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#0E1413');
  expect(localStorage.getItem(KEY)).toBeNull();
  os.flip(false);
  expect(shown()).toBe('pierre');
});

it('stops following the device once a palette is chosen', () => {
  const os = device(false);
  applyTheme('system');
  applyTheme('odyssey');
  expect(os.listeners.size).toBe(0);
  os.flip(true);
  expect(shown()).toBe('odyssey');
});

it('migrates a cached retired theme once, then keeps the migrated choice', () => {
  device(false);
  localStorage.setItem(KEY, 'abyss');
  initializeTheme();
  expect(shown()).toBe('encre');
  expect(localStorage.getItem(KEY)).toBe('encre');

  localStorage.setItem(KEY, 'performance');
  initializeTheme();
  expect(shown()).toBe('pierre');
  expect(localStorage.getItem(KEY)).toBe('pierre');
});

it('keeps a kept palette untouched and still renders when storage is unavailable', () => {
  device(true);
  localStorage.setItem(KEY, 'odyssey');
  initializeTheme();
  expect(shown()).toBe('odyssey');
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  initializeTheme();
  expect(shown()).toBe('encre');
  vi.restoreAllMocks();
});
