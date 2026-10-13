// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GENERIC_STEPS_LABEL, workoutApi, type WorkoutView } from '@/lib/workouts';
import { WorkoutCard } from './WorkoutCard';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const view = (needs_steps: boolean): WorkoutView => ({
  session: {
    id: 42, revision: 1, date: '2027-01-12', sport: 'running', status: 'pending',
    description: "VMA — 12×400 @3'33 r1'", summary: "10' Z2 · 8×(3' Z5 / 2' Z1) · 10' Z1",
    prescription: { version: 1, steps: [{ kind: 'effort', duration_kind: 'seconds', value: 600, steps: [] }] },
    derived: true, needs_steps, exportable: !needs_steps,
    reason: needs_steps ? 'Séance décrite sans étapes : complète-les pour l’export Garmin.' : null,
  },
  export: null,
});

function mount(initial: WorkoutView) {
  vi.spyOn(workoutApi, 'inspect').mockResolvedValue(initial);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><WorkoutCard sessionId={42} initial={initial} compact /></QueryClientProvider>);
}

it('labels the template of a described session as a generic estimate to complete', () => {
  mount(view(true));
  expect(screen.getByText(GENERIC_STEPS_LABEL)).toBeTruthy();
  expect(screen.queryByText('Étapes dérivées du planning')).toBeNull();
  expect(screen.getByRole('button', { name: 'Compléter les étapes' })).toBeTruthy();
});

it('keeps derived steps editable as the session when nothing contradicts them', () => {
  mount(view(false));
  expect(screen.getByText('Étapes dérivées du planning')).toBeTruthy();
  expect(screen.queryByText(GENERIC_STEPS_LABEL)).toBeNull();
  expect(screen.getByRole('button', { name: 'Modifier' })).toBeTruthy();
});
