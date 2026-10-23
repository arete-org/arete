// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { COACH_DISPLAY_KEY, useCoachDisplay } from './useCoachDisplay';

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('migrates old choices to floating once and persists subsequent explicit choices', () => {
  localStorage.setItem('arete.coach-display.v1', 'sidebar');
  const { result, unmount } = renderHook(useCoachDisplay);
  expect(result.current.mode).toBe('floating');
  act(() => result.current.setMode('floating'));
  unmount();
  const reloaded = renderHook(useCoachDisplay);
  expect(reloaded.result.current.mode).toBe('floating');
  act(() => reloaded.result.current.setMode('sidebar'));
  reloaded.unmount();
  expect(renderHook(useCoachDisplay).result.current.mode).toBe('sidebar');
});

it('lets the user opt in and out for the session when browser storage is blocked', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  const { result } = renderHook(useCoachDisplay);
  expect(result.current.mode).toBe('floating');
  expect(result.current.error).toContain('ne peut pas enregistrer');
  act(() => result.current.setMode('floating'));
  expect(result.current.mode).toBe('floating');
  expect(result.current.error).toContain('cette session');
  act(() => result.current.setMode('sidebar'));
  expect(result.current.mode).toBe('sidebar');
});

it('falls back to floating for unknown preferences', () => {
  localStorage.setItem(COACH_DISPLAY_KEY, 'invalid');
  expect(renderHook(useCoachDisplay).result.current.mode).toBe('floating');
});
