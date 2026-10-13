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

/** Types digits one key at a time into the formatted text, as on a numeric keypad. */
function type(input: HTMLInputElement, keys: string) {
  for (const key of keys) fireEvent.change(input, { target: { value: key === '⌫' ? input.value.slice(0, -1) : input.value + key } });
}

it('types durations as digits that fill h:mm:ss from the right and stores seconds', () => {
  const latest = mount(warmup);
  const duration = screen.getByLabelText('Durée (h:mm:ss)') as HTMLInputElement;
  expect([duration.inputMode, duration.placeholder]).toEqual(['numeric', '0:00']);
  expect(screen.getByText('Tape 2000 pour 20:00')).toBeTruthy();
  expect(duration.value).toBe('10:00');
  type(duration, '⌫⌫⌫⌫');
  // Never a partial value: an empty field leaves the step unset, and it cannot be saved.
  expect(duration.value).toBe('');
  expect(latest.current.steps[0].value).toBeNull();
  expect(prescriptionReady(latest.current)).toBe(false);
  expect(screen.getByRole('alert').textContent).toBe('Indique la durée.');
  type(duration, '2000');
  expect(duration.value).toBe('20:00');
  expect(latest.current.steps[0].value).toBe(1200);
  expect(screen.queryByRole('alert')).toBeNull();
  for (const [keys, text, seconds] of [['13000', '1:30:00', 5400], ['100', '1:00', 60]] as const) {
    fireEvent.focus(duration);
    type(duration, keys);
    expect(duration.value).toBe(text);
    expect(latest.current.steps[0].value).toBe(seconds);
  }
});

it('restarts a focused duration with the first digit typed', () => {
  const latest = mount({ version: 1, steps: [{ kind: 'warmup', duration_kind: 'seconds', value: 1200, steps: [] }] });
  const duration = screen.getByLabelText('Durée (h:mm:ss)') as HTMLInputElement;
  fireEvent.focus(duration);
  expect([duration.selectionStart, duration.selectionEnd]).toEqual([0, 5]);
  type(duration, '25');
  expect(duration.value).toBe('0:25');
  expect(latest.current.steps[0].value).toBe(25);
});

it('keeps the caret at the end, where Backspace always removes the last digit', () => {
  mount({ version: 1, steps: [{ kind: 'warmup', duration_kind: 'seconds', value: 1200, steps: [] }] });
  const duration = screen.getByLabelText('Durée (h:mm:ss)') as HTMLInputElement;
  duration.focus();
  // An arrow key or a tap moves the caret back to the end.
  duration.setSelectionRange(2, 2);
  fireEvent.keyUp(duration, { key: 'ArrowLeft' });
  expect([duration.selectionStart, duration.selectionEnd]).toEqual([5, 5]);
  // Even a deletion that took the separator removes the last digit.
  fireEvent.change(duration, { target: { value: '2000' } });
  expect(duration.value).toBe('2:00');
});

it('keeps seconds over 60 as typed, then normalises them on blur', () => {
  const latest = mount({ version: 1, steps: [{ kind: 'rest', duration_kind: 'seconds', value: 60, steps: [] }] }, 'strength');
  const duration = screen.getByLabelText('Durée (h:mm:ss)') as HTMLInputElement;
  fireEvent.focus(duration);
  type(duration, '90');
  expect(duration.value).toBe('0:90');
  expect(latest.current.steps[0].value).toBe(90);
  fireEvent.blur(duration);
  expect(duration.value).toBe('1:30');
});

it('accepts a pasted plain duration and refuses anything else, leaving the field unchanged', () => {
  const latest = mount(warmup);
  const duration = screen.getByLabelText('Durée (h:mm:ss)') as HTMLInputElement;
  const paste = (text: string) => fireEvent.paste(duration, { clipboardData: { getData: () => text } });
  paste('20:00');
  expect(duration.value).toBe('20:00');
  expect(latest.current.steps[0].value).toBe(1200);
  for (const text of ['1h30', '20 min', 'abc']) {
    paste(text);
    expect(duration.value).toBe('20:00');
    expect(latest.current.steps[0].value).toBe(1200);
    expect(screen.getByRole('alert').textContent).toBe('Collage refusé : chiffres ou durée comme 1:30:00.');
  }
  type(duration, '⌫');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('blocks a duration over 24:00:00', () => {
  const latest = mount(warmup);
  const duration = screen.getByLabelText('Durée (h:mm:ss)') as HTMLInputElement;
  fireEvent.focus(duration);
  type(duration, '240001');
  expect(latest.current.steps[0].value).toBe(86_401);
  expect(prescriptionReady(latest.current)).toBe(false);
  expect(screen.getByRole('alert').textContent).toBe('Durée au-delà de 24:00:00 : vérifie la saisie.');
});

it("types a pace range as digits in m'ss per km, starting empty and never storing a partial bound", () => {
  const latest = mount(warmup);
  fireEvent.change(screen.getByLabelText('Cible', { selector: 'select' }), { target: { value: 'pace_sec_km' } });
  expect(latest.current.steps[0].target).toEqual({ kind: 'pace_sec_km', low: null, high: null });
  expect(prescriptionReady(latest.current)).toBe(false);
  const low = screen.getByLabelText("Allure minimum (min'ss par km)") as HTMLInputElement;
  const high = screen.getByLabelText("Allure maximum (min'ss par km)") as HTMLInputElement;
  expect([low.value, high.value, high.inputMode, high.placeholder]).toEqual(['', '', 'numeric', "0'00"]);
  expect(screen.getAllByText("Tape 330 pour 3'30")).toHaveLength(2);
  type(low, '330');
  type(high, '375');
  expect([low.value, high.value]).toEqual(["3'30", "3'75"]);
  expect(latest.current.steps[0].target).toEqual({ kind: 'pace_sec_km', low: 210, high: 255 });
  expect(prescriptionReady(latest.current)).toBe(true);
  fireEvent.blur(high);
  expect(high.value).toBe("4'15");
  type(high, '⌫⌫⌫');
  expect(latest.current.steps[0].target?.high).toBeNull();
  expect(prescriptionReady(latest.current)).toBe(false);
  expect(screen.getByRole('alert').textContent).toBe('Indique l’allure.');
});

it('blocks an inverted range and an implausible pace with an inline error', () => {
  const latest = mount(warmup);
  fireEvent.change(screen.getByLabelText('Cible', { selector: 'select' }), { target: { value: 'pace_sec_km' } });
  const low = screen.getByLabelText("Allure minimum (min'ss par km)") as HTMLInputElement;
  const high = screen.getByLabelText("Allure maximum (min'ss par km)") as HTMLInputElement;
  type(low, '415');
  type(high, '330');
  expect(prescriptionReady(latest.current)).toBe(false);
  expect(screen.getByRole('alert').textContent).toBe('Le minimum ne peut pas dépasser le maximum.');
  fireEvent.focus(low);
  type(low, '100');
  expect(latest.current.steps[0].target).toEqual({ kind: 'pace_sec_km', low: 60, high: 210 });
  expect(prescriptionReady(latest.current)).toBe(false);
  expect(screen.getByRole('alert').textContent).toBe("Allure attendue entre 1'30 et 30'00 par km.");
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
