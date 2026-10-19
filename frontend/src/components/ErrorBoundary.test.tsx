// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { reloadPage } from '@/lib/chunkReload';
import { ErrorBoundary } from './ErrorBoundary';

vi.mock('@/lib/chunkReload', async (original) => ({ ...(await original<typeof import('@/lib/chunkReload')>()), reloadPage: vi.fn() }));

const chunk = new TypeError('Failed to fetch dynamically imported module: /assets/Planning-x.js');
function Broken({ error }: { error: Error }): never { throw error; }

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(reloadPage).mockClear(); });

function offline(value: boolean) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(!value);
}

it('reloads once back online while a part that failed offline still shows its error', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  offline(true);
  render(<ErrorBoundary><Broken error={chunk} /></ErrorBoundary>);
  expect(screen.getByText('Cette section n’a pas pu s’afficher.')).toBeTruthy();
  offline(false);
  act(() => { window.dispatchEvent(new Event('online')); });
  expect(reloadPage).toHaveBeenCalledTimes(1);
});

it('never reloads over another screen once that error is gone', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  offline(true);
  const view = render(<ErrorBoundary><Broken error={chunk} /></ErrorBoundary>);
  view.unmount();
  act(() => { window.dispatchEvent(new Event('online')); });
  expect(reloadPage).not.toHaveBeenCalled();
});

it('« Réessayer » reloads for a missing part, and renders again for any other error', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const first = render(<ErrorBoundary><Broken error={chunk} /></ErrorBoundary>);
  fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
  expect(reloadPage).toHaveBeenCalledTimes(1);
  first.unmount();
  render(<ErrorBoundary><Broken error={new Error('boom')} /></ErrorBoundary>);
  fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
  expect(reloadPage).toHaveBeenCalledTimes(1);
});
