// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import type { Prescription } from '@/lib/documents';
import { PrescriptionEditor } from './PrescriptionEditor';

afterEach(cleanup);

function mount(initial: Prescription) {
  const latest = { current: initial };
  function Host() {
    const [value, setValue] = useState(initial);
    return <PrescriptionEditor sport="running" value={value} onChange={next => { latest.current = next; setValue(next); }} />;
  }
  render(<QueryClientProvider client={new QueryClient()}><Host /></QueryClientProvider>);
  return latest;
}

const warmup: Prescription = { version: 1, steps: [{ kind: 'warmup', duration_kind: 'seconds', value: 600, steps: [] }] };

it('types durations as mm:ss or minutes and stores seconds', () => {
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
  // Never a partial value: the step has none until the text reads in full.
  expect(latest.current.steps[0].value).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('mm:ss');
  expect(duration.value).toBe('1:3');
  fireEvent.change(duration, { target: { value: '1:05:00' } });
  expect(latest.current.steps[0].value).toBe(3900);
  expect(screen.queryByRole('alert')).toBeNull();
});

it("types a pace range as m'ss per km and stores seconds per km", () => {
  const latest = mount(warmup);
  fireEvent.change(screen.getByLabelText('Cible', { selector: 'select' }), { target: { value: 'pace_sec_km' } });
  const [low, high] = screen.getAllByLabelText(/^(Minimum|Maximum)$/) as HTMLInputElement[];
  fireEvent.change(low, { target: { value: "3'30" } });
  fireEvent.change(high, { target: { value: "3'36" } });
  expect(latest.current.steps[0].target).toEqual({ kind: 'pace_sec_km', low: 210, high: 216 });
  expect(high.value).toBe("3'36");
  fireEvent.change(high, { target: { value: '216' } });
  expect(screen.getByRole('alert').textContent).toBe("Allure attendue en m'ss (3'30).");
});

it('checks "skip the last recovery" on a new repeat, and unchecking stores false', () => {
  const latest = mount(warmup);
  fireEvent.change(screen.getByLabelText('Type de l’étape 1'), { target: { value: 'repeat' } });
  const skip = screen.getByLabelText('Ne pas faire la dernière récup') as HTMLInputElement;
  expect(skip.checked).toBe(true);
  expect(latest.current.steps[0].skip_last_recovery).toBe(true);
  fireEvent.click(skip);
  expect(latest.current.steps[0].skip_last_recovery).toBe(false);
  // Back to a plain step: the flag belongs to repeats only.
  fireEvent.change(screen.getAllByLabelText('Type de l’étape 1')[0], { target: { value: 'effort' } });
  expect(latest.current.steps[0].skip_last_recovery).toBeNull();
});

it('leaves a repeat stored before the option unchecked', () => {
  mount({ version: 1, steps: [{ kind: 'repeat', duration_kind: 'lap', repeat: 6, steps: [
    { kind: 'effort', duration_kind: 'meters', value: 400, steps: [] },
    { kind: 'recovery', duration_kind: 'seconds', value: 60, steps: [] },
  ] }] });
  expect((screen.getByLabelText('Ne pas faire la dernière récup') as HTMLInputElement).checked).toBe(false);
});
