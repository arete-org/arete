// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { garminApi, settingsApi, strengthApi, tipsApi } from '@/lib/api';
import type { StrengthDraft } from '@/types';
import { LogPage } from './Log';

// Panels unrelated to the session screens.
vi.mock('@/components/PlayerSummary', () => ({ PlayerSummary: () => null }));
vi.mock('./log/ExerciseProgress', () => ({ ExerciseProgress: () => null }));
vi.mock('./log/RecentSessions', () => ({ RecentSessions: () => null }));

const draft: StrengthDraft = {
  id: 7, actual_session_id: 41, date: '2026-10-15', name: 'Musculation', duration_min: 52, origin: 'import',
  exercises: [{ name: 'Squat', exercise_id: 'back_squat', sets: 5, reps: 5 }],
  notation: 'Squat 5x5',
} as StrengthDraft;

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(settingsApi, 'get').mockResolvedValue({ weekly_volume_target_kg: 20000 } as Awaited<ReturnType<typeof settingsApi.get>>);
  vi.spyOn(strengthApi, 'getSessions').mockResolvedValue([]);
  vi.spyOn(strengthApi, 'getMuscleStats').mockResolvedValue({ muscles: [] } as unknown as Awaited<ReturnType<typeof strengthApi.getMuscleStats>>);
  vi.spyOn(strengthApi, 'getDrafts').mockResolvedValue({ items: [draft], total: 1 });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

/** Opens the tab at `url` as its first page, then renders the app's Home and Journal. */
function openTab(url: string) {
  window.history.replaceState(null, '', url);
  render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<><h1>Accueil</h1><Link to="/log">Journal</Link><Link to="/log?tab=cardio&new=1">Sans montre</Link><Link to="/log?new=1">Saisir une séance</Link></>} />
          <Route path="/log" element={<LogPage />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

const here = () => window.location.pathname + window.location.search;
const dialogGone = () => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

it('closes an entry the Journal opened in place, adding no history entry', async () => {
  openTab('/');
  fireEvent.click(screen.getByRole('link', { name: 'Journal' }));
  await screen.findByRole('heading', { name: 'Journal' });
  const entries = window.history.length;
  fireEvent.click(screen.getByRole('button', { name: 'Saisir une séance' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByLabelText('Date')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Fermer' }));
  await dialogGone();
  expect(here()).toBe('/log');
  expect(screen.getByRole('heading', { name: 'Journal' })).toBeTruthy();
  expect(window.history.length).toBe(entries);
});

it('closes a draft the Journal opened in place, adding no history entry', async () => {
  openTab('/log');
  const entries = window.history.length;
  fireEvent.click(await screen.findByRole('button', { name: 'Ajoute tes charges' }));
  const dialog = await screen.findByRole('dialog');
  expect(here()).toBe('/log?draft=7');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Fermer' }));
  await dialogGone();
  expect(here()).toBe('/log');
  expect(window.history.length).toBe(entries);
});

it('keeps the Journal cardio tab after a save opened from Home, and Home after a dismissal', async () => {
  vi.spyOn(garminApi, 'createActual').mockResolvedValue({ id: 5 } as Awaited<ReturnType<typeof garminApi.createActual>>);
  vi.spyOn(tipsApi, 'getPostSession').mockResolvedValue({ feedback: 'Belle sortie.', highlights: [], source: 'rules' });
  openTab('/');
  fireEvent.click(screen.getByRole('link', { name: 'Sans montre' }));
  let dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Fermer' }));
  expect(await screen.findByRole('heading', { name: 'Accueil' })).toBeTruthy();

  fireEvent.click(screen.getByRole('link', { name: 'Sans montre' }));
  dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /ENREGISTRER/ }));
  expect(await screen.findByText('Belle sortie.')).toBeTruthy();
  await dialogGone();
  expect(here()).toBe('/log?tab=cardio');
  expect(screen.getByRole('heading', { name: 'Journal' })).toBeTruthy();
});

it('ignores a dismissal while the cardio save is in flight', async () => {
  let finish!: (session: Awaited<ReturnType<typeof garminApi.createActual>>) => void;
  vi.spyOn(garminApi, 'createActual').mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  vi.spyOn(tipsApi, 'getPostSession').mockResolvedValue({ feedback: 'Belle sortie.', highlights: [], source: 'rules' });
  openTab('/');
  fireEvent.click(screen.getByRole('link', { name: 'Sans montre' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /ENREGISTRER/ }));
  await waitFor(() => expect(garminApi.createActual).toHaveBeenCalledOnce());
  fireEvent.click(within(dialog).getByRole('button', { name: 'Fermer' }));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(here()).toBe('/log?tab=cardio&new=1');
  finish({ id: 5 } as Awaited<ReturnType<typeof garminApi.createActual>>);
  expect(await screen.findByText('Belle sortie.')).toBeTruthy();
  expect(here()).toBe('/log?tab=cardio');
});

it('ignores a dismissal while the strength save is in flight', async () => {
  const parsed = {
    success: true, date: '2026-10-15', name: null, duration_min: null, overall_rpe: null, notes: null,
    session_id: null, message: null, unparsed_lines: [], records: [],
    exercises: [{ name: 'Squat', exercise_id: 'back_squat', exercise_matched: true, notes: null, match_score: 100, suggestions: [],
      sets: [{ set_number: 1, reps: 5, weight_kg: 100, is_warmup: false, is_failure: false }] }],
  } as unknown as Awaited<ReturnType<typeof strengthApi.parseWorkout>>;
  let finish!: (value: typeof parsed) => void;
  vi.spyOn(strengthApi, 'parseWorkout').mockImplementation((_text, _date, save) =>
    save ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(parsed));
  vi.spyOn(tipsApi, 'getPostSession').mockResolvedValue({ feedback: 'Belle séance.', highlights: [], source: 'rules' });
  openTab('/');
  fireEvent.click(screen.getByRole('link', { name: 'Saisir une séance' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Séance en texte libre' }), { target: { value: 'Squat 1x5@100' } });
  fireEvent.click(within(dialog).getByRole('button', { name: /ANALYSER/ }));
  fireEvent.click(await within(dialog).findByRole('button', { name: /ENREGISTRER/ }));
  await waitFor(() => expect(strengthApi.parseWorkout).toHaveBeenCalledTimes(2));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Fermer' }));
  expect(here()).toBe('/log?new=1');
  finish({ ...parsed, session_id: 90 } as typeof parsed);
  expect(await within(dialog).findByText('SÉANCE ENREGISTRÉE')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'FERMER' }));
  expect(await screen.findByRole('heading', { name: 'Accueil' })).toBeTruthy();
});
