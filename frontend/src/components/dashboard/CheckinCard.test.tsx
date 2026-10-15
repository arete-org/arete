// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { checkinApi, type CheckinSaved } from '@/lib/checkins';
import { qk } from '@/lib/queryKeys';
import { CheckinCard } from './CheckinCard';

const DAY = '2026-10-15';
const saved = (fields: Partial<CheckinSaved> = {}): CheckinSaved => ({
  date: DAY, sleep: 2, legs: 4, mood: null, note: null,
  answered_at: `${DAY}T05:12:00+00:00`, updated_at: `${DAY}T05:12:00+00:00`, replanned: false, ...fields,
});

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});
const mount = (props: Partial<Parameters<typeof CheckinCard>[0]> = {}) =>
  render(
    <QueryClientProvider client={client}>
      <CheckinCard day={DAY} {...props} />
    </QueryClientProvider>,
  );
const region = () => screen.queryByRole('region', { name: 'Check-in du matin' });

it('answers in three taps and writes the answer into the dashboard', async () => {
  const save = vi.spyOn(checkinApi, 'save').mockResolvedValue(saved());
  const refresh = vi.spyOn(client, 'invalidateQueries');
  client.setQueryData(qk.dashboard(DAY), { date: DAY, checkin: null });
  mount();
  const send = screen.getByRole<HTMLButtonElement>('button', { name: 'Valider' });
  expect(send.disabled).toBe(true);
  for (const question of ['Sommeil ?', 'Jambes ?', 'Motivation / stress (facultatif)']) {
    expect(screen.getByRole('radiogroup', { name: question })).toBeTruthy();
  }

  fireEvent.click(screen.getByRole('radio', { name: '2 sur 5 — mauvais' }));
  expect(send.disabled).toBe(true); // the legs are not optional
  fireEvent.click(screen.getByRole('radio', { name: '4 sur 5 — légères' }));
  fireEvent.click(send);

  await waitFor(() => expect(save).toHaveBeenCalledWith(DAY, { sleep: 2, legs: 4, mood: null, note: null }));
  await waitFor(() => expect(client.getQueryData(qk.dashboard(DAY))).toMatchObject({ checkin: { sleep: 2, legs: 4 } }));
  expect(client.getQueryData<{ checkin: object }>(qk.dashboard(DAY))?.checkin).not.toHaveProperty('replanned');
  // The dashboard is read again (its refresh was cancelled); the coach card only with a proposal.
  expect(refresh).toHaveBeenCalledWith({ queryKey: qk.dashboard() });
  expect(refresh).not.toHaveBeenCalledWith({ queryKey: ['coachToday'] });
});

it('sends the optional answer and word, and a new proposal refreshes the coach card', async () => {
  const save = vi.spyOn(checkinApi, 'save').mockResolvedValue(saved({ legs: 1, replanned: true }));
  const refresh = vi.spyOn(client, 'invalidateQueries');
  mount();
  fireEvent.click(screen.getByRole('radio', { name: '3 sur 5 — moyen' }));
  fireEvent.click(screen.getByRole('radio', { name: '1 sur 5 — très lourdes' }));
  fireEvent.click(screen.getByRole('radio', { name: '5 sur 5 — motivé et serein' }));
  fireEvent.click(screen.getByRole('button', { name: '+ Ajouter un mot' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Un mot (facultatif)' }), { target: { value: ' Course hier ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Valider' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(DAY, { sleep: 3, legs: 1, mood: 5, note: 'Course hier' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledWith({ queryKey: qk.dashboard() }));
  expect(refresh).toHaveBeenCalledWith({ queryKey: ['coachToday'] });
});

it('says when the answer was not saved, and keeps it to send again', async () => {
  vi.spyOn(checkinApi, 'save').mockRejectedValue(new ApiError(422, '{"detail":"Ce jour n\'est pas encore arrivé."}'));
  mount();
  fireEvent.click(screen.getByRole('radio', { name: '4 sur 5 — bon' }));
  fireEvent.click(screen.getByRole('radio', { name: '3 sur 5 — normales' }));
  fireEvent.click(screen.getByRole('button', { name: 'Valider' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/pas encore arrivé/);
  expect(screen.getByRole<HTMLInputElement>('radio', { name: '4 sur 5 — bon' }).checked).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Valider' }).disabled).toBe(false);
});

it('« Plus tard » hides it for the day; the push link brings it back focused', () => {
  const first = mount();
  fireEvent.click(screen.getByRole('button', { name: /Plus tard/ }));
  expect(region()).toBeNull();
  first.unmount();

  mount();
  expect(region()).toBeNull(); // the same day, remembered
  cleanup();

  mount({ day: '2026-10-16' });
  expect(region()).not.toBeNull(); // a new day asks again
  cleanup();

  mount({ focus: true });
  expect(region()).not.toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: '1 sur 5 — très mauvais' }));
});

it('the optional answer can be withdrawn, and the word field takes the focus', async () => {
  const save = vi.spyOn(checkinApi, 'save').mockResolvedValue(saved());
  mount();
  expect(screen.queryByRole('button', { name: /Effacer/ })).toBeNull();
  const calm = screen.getByRole<HTMLInputElement>('radio', { name: '5 sur 5 — motivé et serein' });
  fireEvent.click(calm);
  fireEvent.click(screen.getByRole('button', { name: 'Effacer la réponse Motivation / stress' }));
  expect(calm.checked).toBe(false);
  // The button leaves with the answer: the focus goes back to the question, not the page.
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: '1 sur 5 — stressé, sans envie' }));
  expect(screen.getByRole('radiogroup', { name: 'Motivation / stress (facultatif)' }).contains(document.activeElement)).toBe(true);
  expect(screen.queryByRole('button', { name: /Effacer/ })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: '+ Ajouter un mot' }));
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Un mot (facultatif)' }));

  fireEvent.click(screen.getByRole('radio', { name: '2 sur 5 — mauvais' }));
  fireEvent.click(screen.getByRole('radio', { name: '4 sur 5 — légères' }));
  fireEvent.click(screen.getByRole('button', { name: 'Valider' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(DAY, { sleep: 2, legs: 4, mood: null, note: null }));
});

it('tells the page once it took the focus from the push link', () => {
  const focused = vi.fn();
  mount({ focus: true, onFocused: focused });
  expect(focused).toHaveBeenCalledTimes(1);
});
