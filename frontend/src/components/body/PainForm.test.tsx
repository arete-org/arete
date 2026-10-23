// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, settingsApi } from '@/lib/api';
import { bodyApi, bodyKeys, shiftDay, todayIn, type PainEntry } from '@/lib/bodyLog';
import { qk } from '@/lib/queryKeys';
import { BodyLogEntry } from './BodyLogEntry';
import { PainForm } from './PainForm';
import { WeightForm } from './WeightForm';

/** UTC+14: on another calendar day than most browsers, as the athlete's clock may be. */
const ZONE = 'Pacific/Kiritimati';
const TODAY = todayIn(ZONE);
const SESSION_DAY = shiftDay(TODAY, -2);
const stored = (fields: Partial<PainEntry> = {}): PainEntry => ({
  id: 7, date: TODAY, area: 'knee', side: 'left', intensity: 5, note: null, label: 'genou, côté gauche',
  created_at: `${TODAY}T07:00:00Z`, updated_at: `${TODAY}T07:00:00Z`, ...fields,
});

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  // The app's settings provider has read them before any form opens.
  client.setQueryData(qk.settings, { timezone: ZONE });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});
const mount = (node: React.ReactNode) =>
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );

it('records a pain in three choices and refreshes the trend', async () => {
  const add = vi.spyOn(bodyApi, 'addPain').mockResolvedValue(stored());
  const refresh = vi.spyOn(client, 'invalidateQueries');
  const saved = vi.fn();
  mount(<PainForm onSaved={saved} />);
  const send = screen.getByRole<HTMLButtonElement>('button', { name: 'Enregistrer' });
  expect(send.disabled).toBe(true);

  fireEvent.change(screen.getByLabelText('Zone'), { target: { value: 'knee' } });
  expect(send.disabled).toBe(true); // the intensity is not optional
  fireEvent.click(screen.getByRole('radio', { name: 'Gauche' }));
  fireEvent.click(screen.getByRole('radio', { name: '5 sur 10' }));
  fireEvent.change(screen.getByLabelText('Note (facultatif)'), { target: { value: '  en descente ' } });
  fireEvent.click(send);

  await waitFor(() =>
    expect(add).toHaveBeenCalledWith({ date: TODAY, area: 'knee', side: 'left', intensity: 5, note: 'en descente' }),
  );
  await waitFor(() => expect(saved).toHaveBeenCalledWith(stored()));
  expect(refresh).toHaveBeenCalledWith({ queryKey: bodyKeys.all });
});

it('corrects an entry in place, starting from what it says', async () => {
  const update = vi.spyOn(bodyApi, 'updatePain').mockResolvedValue(stored({ intensity: 2 }));
  mount(<PainForm entry={stored({ note: 'raide' })} />);
  expect(screen.getByRole<HTMLInputElement>('radio', { name: '5 sur 10' }).checked).toBe(true);
  expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Gauche' }).checked).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: '2 sur 10' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Aucun côté' }));
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(7, { date: TODAY, area: 'knee', side: null, intensity: 2, note: 'raide' }),
  );
});

it('says why a refused entry was not saved, and keeps it', async () => {
  vi.spyOn(bodyApi, 'addPain').mockRejectedValue(
    new ApiError(422, JSON.stringify({ detail: 'Une saisie remonte au plus à 90 jours.' })),
  );
  mount(<PainForm />);
  fireEvent.change(screen.getByLabelText('Zone'), { target: { value: 'hip' } });
  fireEvent.click(screen.getByRole('radio', { name: '0 sur 10 — aucune' }));
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Une saisie remonte au plus à 90 jours.');
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Zone' }).value).toBe('hip');
});

it('the quick entry opens one form at a time, dates a pain on the session and confirms', async () => {
  const add = vi.spyOn(bodyApi, 'addPain').mockResolvedValue(stored({ date: SESSION_DAY }));
  mount(<BodyLogEntry painDate={SESSION_DAY} weight={false} />);
  expect(screen.queryByRole('button', { name: 'Noter mon poids' })).toBeNull();
  const open = screen.getByRole('button', { name: 'Signaler une douleur' });
  expect(open.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(open);
  expect(open.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByLabelText<HTMLInputElement>('Jour').value).toBe(SESSION_DAY);
  fireEvent.change(screen.getByLabelText('Zone'), { target: { value: 'knee' } });
  fireEvent.click(screen.getByRole('radio', { name: '5 sur 10' }));
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(add).toHaveBeenCalled());
  expect((await screen.findByRole('status')).textContent).toBe('Douleur enregistrée : genou, côté gauche, 5/10.');
  expect(screen.queryByRole('form')).toBeNull();
});

it('records the day’s weight typed with a comma', async () => {
  const save = vi.spyOn(bodyApi, 'saveWeight').mockResolvedValue({
    date: TODAY, weight_kg: 71.4, source: 'manual', created_at: `${TODAY}T07:00:00Z`, updated_at: `${TODAY}T07:00:00Z`,
  });
  mount(<BodyLogEntry />);
  fireEvent.click(screen.getByRole('button', { name: 'Noter mon poids' }));
  const input = screen.getByLabelText('Poids (kg)');
  fireEvent.change(input, { target: { value: '12' } });
  expect(screen.getByText('Un poids va de 25 à 250 kg.')).toBeTruthy();
  fireEvent.change(input, { target: { value: '71,4' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(TODAY, 71.4));
  expect((await screen.findByRole('status')).textContent).toBe('Poids enregistré : 71,4 kg.');
});

it('dates on the athlete’s day, and a session older than the log accepts on today', () => {
  mount(<PainForm defaultDate={shiftDay(TODAY, -120)} />);
  const day = screen.getByLabelText<HTMLInputElement>('Jour');
  expect(day.value).toBe(TODAY);
  expect(day.max).toBe(TODAY);
  expect(day.min).toBe(shiftDay(TODAY, -90));
});

it('follows the athlete’s day once Settings load, unless the athlete chose one', async () => {
  client.removeQueries({ queryKey: qk.settings });
  vi.spyOn(settingsApi, 'get').mockReturnValue(new Promise(() => {}));
  mount(<WeightForm />);
  const day = screen.getByLabelText<HTMLInputElement>('Jour');
  expect(day.value).toBe(todayIn(null)); // the browser's day until Settings answer
  act(() => {
    client.setQueryData(qk.settings, { timezone: ZONE });
  });
  await waitFor(() => expect(day.value).toBe(TODAY));
  fireEvent.change(day, { target: { value: shiftDay(TODAY, -3) } });
  act(() => {
    client.setQueryData(qk.settings, { timezone: 'Pacific/Pago_Pago' });
  });
  expect(day.value).toBe(shiftDay(TODAY, -3));
});

it('dates the day’s weight on the athlete’s clock, bounded to the 90 days before it', () => {
  mount(<WeightForm />);
  const day = screen.getByLabelText<HTMLInputElement>('Jour');
  expect(day.value).toBe(TODAY);
  expect(day.max).toBe(TODAY);
  expect(day.min).toBe(shiftDay(TODAY, -90));
});
