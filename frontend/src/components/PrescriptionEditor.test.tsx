// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import type { Prescription } from '@/lib/documents';
import { prescriptionReady } from '@/lib/workouts';
import { PrescriptionEditor } from './PrescriptionEditor';

afterEach(cleanup);

function mount(initial: Prescription, sport = 'running') {
  const latest = { current: initial };
  function Host() {
    const [value, setValue] = useState(initial);
    return <PrescriptionEditor sport={sport} value={value} onChange={next => { latest.current = next; setValue(next); }} />;
  }
  render(<QueryClientProvider client={new QueryClient()}><Host /></QueryClientProvider>);
  return latest;
}

const warmup: Prescription = { version: 1, steps: [{ kind: 'warmup', duration_kind: 'seconds', value: 600, steps: [] }] };
const intervals = (last: Prescription['steps'][number], skip?: boolean): Prescription => ({ version: 1, steps: [{ kind: 'repeat', duration_kind: 'lap', repeat: 6, skip_last_recovery: skip, steps: [
  { kind: 'effort', duration_kind: 'meters', value: 400, steps: [] }, last,
] }] });
const recovery = { kind: 'recovery' as const, duration_kind: 'seconds' as const, value: 60, steps: [] };
const skipBox = () => screen.queryByLabelText('Ne pas faire la dernière récup') as HTMLInputElement | null;

it('types running durations as mm:ss or minutes and stores seconds', () => {
  const latest = mount(warmup);
  const duration = screen.getByLabelText('Durée (mm:ss)') as HTMLInputElement;
  expect(duration.value).toBe('10:00');
  fireEvent.change(duration, { target: { value: '20' } });
  expect(latest.current.steps[0].value).toBe(1200);
  fireEvent.blur(duration);
  expect(duration.value).toBe('20:00');
  fireEvent.change(duration, { target: { value: '1:30' } });
  expect(latest.current.steps[0].value).toBe(90);
  fireEvent.change(duration, { target: { value: '1:3' } });
  // Never a partial value: the step has none, and cannot be saved, until the text reads in full.
  expect(latest.current.steps[0].value).toBeNull();
  expect(prescriptionReady(latest.current)).toBe(false);
  expect(screen.getByRole('alert').textContent).toContain('mm:ss');
  expect(duration.value).toBe('1:3');
  fireEvent.change(duration, { target: { value: '1:05:00' } });
  expect(latest.current.steps[0].value).toBe(3900);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('reads a bare strength duration as seconds', () => {
  const latest = mount({ version: 1, steps: [{ kind: 'rest', duration_kind: 'seconds', value: 60, steps: [] }] }, 'strength');
  const duration = screen.getByLabelText('Durée (s ou mm:ss)') as HTMLInputElement;
  fireEvent.change(duration, { target: { value: '90' } });
  expect(latest.current.steps[0].value).toBe(90);
  fireEvent.blur(duration);
  expect(duration.value).toBe('1:30');
});

it("types a pace range as m'ss per km, starting empty and never storing a partial bound", () => {
  const latest = mount(warmup);
  fireEvent.change(screen.getByLabelText('Cible', { selector: 'select' }), { target: { value: 'pace_sec_km' } });
  expect(latest.current.steps[0].target).toEqual({ kind: 'pace_sec_km', low: null, high: null });
  expect(prescriptionReady(latest.current)).toBe(false);
  const [low, high] = screen.getAllByLabelText(/^(Minimum|Maximum)$/) as HTMLInputElement[];
  expect([low.value, high.value]).toEqual(['', '']);
  fireEvent.change(low, { target: { value: "3'30" } });
  fireEvent.change(high, { target: { value: "3'36" } });
  expect(latest.current.steps[0].target).toEqual({ kind: 'pace_sec_km', low: 210, high: 216 });
  expect(prescriptionReady(latest.current)).toBe(true);
  expect(high.value).toBe("3'36");
  fireEvent.change(high, { target: { value: "3'3" } });
  expect(latest.current.steps[0].target?.high).toBeNull();
  expect(prescriptionReady(latest.current)).toBe(false);
  expect(screen.getByRole('alert').textContent).toBe("Allure attendue en m'ss (3'30).");
});

it('creates a repeat as effort then recovery with "skip the last recovery" checked', () => {
  const latest = mount(warmup);
  fireEvent.change(screen.getByLabelText('Type de l’étape 1'), { target: { value: 'repeat' } });
  expect(latest.current.steps[0].steps.map(s => s.kind)).toEqual(['effort', 'recovery']);
  expect(skipBox()?.checked).toBe(true);
  expect(latest.current.steps[0].skip_last_recovery).toBe(true);
  fireEvent.click(skipBox()!);
  expect(latest.current.steps[0].skip_last_recovery).toBe(false);
  // Back to a plain step: the flag belongs to repeats only.
  fireEvent.change(screen.getAllByLabelText('Type de l’étape 1')[0], { target: { value: 'effort' } });
  expect(latest.current.steps[0]).not.toHaveProperty('skip_last_recovery', expect.anything());
});

it('offers the option only when the repeat ends with a timed or measured recovery', () => {
  const latest = mount(intervals(recovery, true));
  expect(skipBox()?.checked).toBe(true);
  // The last recovery becomes an effort: nothing left to skip, the flag is not sent.
  fireEvent.change(screen.getByLabelText('Type de l’étape 2'), { target: { value: 'effort' } });
  expect(skipBox()).toBeNull();
  expect(JSON.stringify(latest.current)).not.toContain('skip_last_recovery');
  cleanup();
  mount(intervals({ ...recovery, duration_kind: 'lap', value: null }));
  expect(skipBox()).toBeNull();
});

it('leaves a repeat stored before the option unchecked', () => {
  mount(intervals(recovery));
  expect(skipBox()?.checked).toBe(false);
});
