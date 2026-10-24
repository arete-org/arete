// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { GenerationPreview } from './GenerationPreview';
import { observeGeneration, type RunSnapshot } from '@/lib/coachingRuns';

vi.mock('@/lib/coachingRuns', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/coachingRuns')>(), observeGeneration: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const snapshot = (id: string, state: string, text: string): RunSnapshot => ({ id, state, revision: 1, projection: { seq: 1, events: [{ type: 'message', id: 'answer', text }] } });
it('observes a new generation without showing yesterday’s completed result or leaking another source', () => {
  const observers: ((value: RunSnapshot) => void)[] = [];
  const signals: AbortSignal[] = [];
  vi.mocked(observeGeneration).mockImplementation((_kind, _id, callback, signal) => {
    observers.push(callback); signals.push(signal); return new Promise(() => {});
  });
  const client = new QueryClient();
  const view = (id?: string) => <QueryClientProvider client={client}><GenerationPreview kind="briefing" sourceId={id} /></QueryClientProvider>;
  const { rerender } = render(view());
  act(() => observers[0](snapshot('yesterday', 'completed', 'Ancien résultat')));
  expect(screen.queryByText('Ancien résultat')).toBeNull();
  act(() => observers[0](snapshot('today', 'running', 'Nouvel aperçu')));
  expect(screen.getByText('Nouvel aperçu')).toBeTruthy();
  act(() => observers[0](snapshot('today', 'completed', 'Résultat enregistré')));
  expect(screen.queryByText('Nouvel aperçu')).toBeNull();
  expect(screen.getByText('Résultat enregistré')).toBeTruthy();
  rerender(view('another-session'));
  expect(signals[0].aborted).toBe(true);
  expect(screen.queryByText('Résultat enregistré')).toBeNull();
  act(() => observers[0](snapshot('today', 'completed', 'Réponse tardive')));
  expect(screen.queryByText('Réponse tardive')).toBeNull();
  act(() => observers[1](snapshot('session', 'running', 'Séance ouverte')));
  expect(screen.getByText('Séance ouverte')).toBeTruthy();
});
