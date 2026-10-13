// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GENERIC_STEPS_LABEL, PARSED_STEPS_LABEL, workoutApi, workoutKey, type WorkoutView } from '@/lib/workouts';
import { StepList, WorkoutCard } from './WorkoutCard';

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
  // The list's batched read fills each card's cache entry.
  client.setQueryData(workoutKey(42), initial);
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

it('says steps read from the description are exportable and starts the editor from them', () => {
  const parsed = view(false);
  parsed.session = {
    ...parsed.session, derived: false, parsed: true,
    prescription: { version: 1, steps: [
      { kind: 'warmup', duration_kind: 'seconds', value: 1200, steps: [] },
      { kind: 'repeat', duration_kind: 'lap', repeat: 12, steps: [
        { kind: 'effort', duration_kind: 'meters', value: 400, steps: [] },
        { kind: 'recovery', duration_kind: 'seconds', value: 60, steps: [] },
      ] },
    ] },
  };
  mount(parsed);
  expect(screen.getByText(PARSED_STEPS_LABEL)).toBeTruthy();
  expect(screen.queryByText(GENERIC_STEPS_LABEL)).toBeNull();
  expect(screen.queryByText('Étapes dérivées du planning')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Modifier' }));
  const kinds = screen.getAllByLabelText(/^Type de l’étape/).map(s => (s as HTMLSelectElement).value);
  expect(kinds).toEqual(['warmup', 'repeat', 'effort', 'recovery']);
});

it("shows durations as mm:ss and paces as m'ss per km", () => {
  const { container } = render(<StepList prescription={{ version: 1, steps: [
    { kind: 'warmup', duration_kind: 'seconds', value: 1200, steps: [] },
    { kind: 'repeat', duration_kind: 'lap', repeat: 12, skip_last_recovery: true, steps: [
      { kind: 'effort', duration_kind: 'meters', value: 400, target: { kind: 'pace_sec_km', low: 210, high: 216 }, steps: [] },
      { kind: 'recovery', duration_kind: 'seconds', value: 60, steps: [] },
    ] },
  ] }} />);
  const text = container.textContent ?? '';
  expect(text).toContain('Échauffement · 20:00');
  expect(text).toContain('12 répétitions, sans la dernière récup');
  expect(text).toContain("400 m · 3'30–3'36/km");
  expect(text).toContain('Récupération · 1:00');
});
