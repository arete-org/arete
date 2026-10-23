// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { usePanelContext } from './pageContext';

afterEach(cleanup);

it('retains the source page and filters UI flags on the embedded coach route', () => {
  const { result } = renderHook(usePanelContext, {
    wrapper: ({ children }) => <MemoryRouter initialEntries={[{ pathname: '/coach', state: { coachFrom: { pathname: '/planning', search: '?date=2026-10-23&contextGaugeAlways=true' } } }]}>{children}</MemoryRouter>,
  });
  expect(result.current).toEqual({ page: 'planning', path: '/planning', params: { date: '2026-10-23' } });
});

it('opens a direct coach URL with the dashboard context', () => {
  const { result } = renderHook(usePanelContext, {
    wrapper: ({ children }) => <MemoryRouter initialEntries={['/coach']}>{children}</MemoryRouter>,
  });
  expect(result.current).toEqual({ page: 'dashboard', path: '/', params: {} });
});

it('keeps the visibility flag out of model context while preserving page parameters', () => {
  const { result } = renderHook(usePanelContext, {
    wrapper: ({ children }) => <MemoryRouter initialEntries={['/planning?date=2026-10-14&contextGaugeAlways=false']}>{children}</MemoryRouter>,
  });
  expect(result.current).toEqual({ page: 'planning', path: '/planning', params: { date: '2026-10-14' } });
});

it('names the Santé page and its report « health », whose data the server reads', () => {
  for (const path of ['/sante', '/sante/rapport']) {
    const { result } = renderHook(usePanelContext, {
      wrapper: ({ children }) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>,
    });
    expect(result.current.page).toBe('health');
  }
});
