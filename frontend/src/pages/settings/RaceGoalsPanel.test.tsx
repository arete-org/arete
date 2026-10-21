// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { goalsApi } from '@/lib/api';
import type { Goal, PlanPreview, PlanWeek } from '@/types';
import { HybridPlanOverview, PlanPreviewModal, PlanWeekList } from './PlanPreviewModal';
import { RaceGoalsPanel } from './RaceGoalsPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Tuesday 20 October 2026, noon: next Monday is the 26th. Only the clock is faked. */
function freezeToday() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 20, 12));
}

const goal: Goal = {
  id: 1,
  name: 'Semi de Paris',
  race_date: '2027-03-07',
  distance_km: 21.1,
  target_time_sec: 6300,
  priority: 'A',
  status: 'active',
  days_left: 149,
  created_at: null,
};

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RaceGoalsPanel />
    </QueryClientProvider>
  );
  return client;
}

it('shows each week with its French phase, minutes and recovery flag', () => {
  const weeks: PlanWeek[] = [
    {
      start: '2026-10-12',
      phase: 'build',
      minutes: 240,
      recovery: true,
      sessions: [
        {
          date: '2026-10-14',
          session_type: 'intervals',
          duration_min: 50,
          hr_zone: 'Z4',
          intensity: 'hard',
          description: '6×800 m',
          distance_km: null,
        },
      ],
    },
    { start: '2026-10-19', phase: 'taper', minutes: 150, recovery: false, sessions: [] },
  ];
  render(<PlanWeekList weeks={weeks} />);
  expect(screen.getByText('Développement')).toBeTruthy();
  expect(screen.getByText('Affûtage')).toBeTruthy();
  expect(screen.getByText('240 min')).toBeTruthy();
  expect(screen.getAllByText('allégée')).toHaveLength(1);
  expect(screen.getByText('Fractionné')).toBeTruthy();
  expect(screen.getByText('6×800 m')).toBeTruthy();
});

it('lists the goals with their countdown and target time', async () => {
  vi.spyOn(goalsApi, 'list').mockResolvedValue([goal]);
  const client = renderPanel();
  expect(await screen.findByText('Semi de Paris')).toBeTruthy();
  expect(screen.getByText('J-149')).toBeTruthy();
  expect(screen.getByText(/21,1 km · objectif 1:45:00/)).toBeTruthy();
  client.clear();
});

it('shows a Hyrox with its division and a hybrid block with its end, never a distance', async () => {
  const block: Goal = {
    ...goal,
    id: 2,
    name: 'Bloc hiver',
    race_date: '2027-01-17',
    distance_km: 0,
    target_time_sec: null,
    goal_type: 'hybrid',
    details: { division: 'open', format: 'solo', category: null, equipment: ['none'], weeks: 12 },
  };
  const hyrox: Goal = {
    ...goal,
    id: 3,
    name: 'Hyrox Paris',
    race_date: '2027-03-20',
    distance_km: 8,
    target_time_sec: 4500,
    goal_type: 'hyrox',
    details: { division: 'open', format: 'doubles', category: 'mixed', equipment: ['sled'], weeks: 12 },
  };
  vi.spyOn(goalsApi, 'list').mockResolvedValue([block, hyrox]);
  const client = renderPanel();
  expect(await screen.findByText('Bloc hiver')).toBeTruthy();
  expect(screen.getByText('Bloc hybride · 12 semaines · fin le 17 janvier 2027')).toBeTruthy();
  expect(screen.getByText('20 mars 2027 · Hyrox Open · Duo · Mixte · objectif 1:15:00')).toBeTruthy();
  expect(screen.queryByText(/ km/)).toBeNull();
  client.clear();
});

const preview: PlanPreview = {
  goal: { ...goal, goal_type: 'hyrox' },
  inputs: {
    weekly_minutes_now: 150,
    sessions_per_week: 6,
    rest_days: [0],
    vdot: 48.5,
    level: 'intermediate',
    training_days: 5,
    deload: true,
    kept: [{ date: '2026-11-04', description: 'Seuil : 2×10’ déplacé' }],
  },
  summary: [
    'Semaine type (base) : mar. course clé + bas du corps (après) · mer. footing · sam. course compromise · lun. et dim. repos',
    'Semaine de course : mer. activation · sam. course · lun. repos',
  ],
  weeks: [
    {
      start: '2026-11-02',
      phase: 'base',
      minutes: 280,
      recovery: true,
      sessions: [
        {
          date: '2026-11-03',
          session_type: 'intervals',
          duration_min: 45,
          hr_zone: null,
          intensity: null,
          description: 'Course compromise : 3×(1 km + 20 wall balls)',
          distance_km: null,
          tags: ['compromised', 'hard', 'run'],
          kind: 'compromised',
        },
        {
          date: '2026-11-04',
          session_type: 'tempo',
          duration_min: 45,
          hr_zone: 'Z4',
          intensity: 'moderate',
          description: 'Seuil : 2×10’ déplacé',
          distance_km: null,
          tags: ['hard', 'kept', 'key_run', 'run'],
          kind: 'key_run',
        },
      ],
      dropped: ['Séance « Footing » retirée : pas de jour libre sans enfreindre les règles d\'enchaînement.'],
    },
  ],
};

it('previews a Hyrox plan: level, days, deload, weekly structure, kept and dropped sessions', () => {
  render(
    <>
      <HybridPlanOverview preview={preview} />
      <PlanWeekList weeks={preview.weeks} />
    </>
  );
  expect(screen.getByText(/Niveau intermédiaire · 5 jours d’entraînement\/sem · 6 séances\/sem/)).toBeTruthy();
  expect(screen.getByText('Ta charge récente est élevée : le plan commence par une semaine allégée.')).toBeTruthy();
  expect(screen.getByText(preview.summary![0])).toBeTruthy();
  expect(screen.getByText(preview.summary![1])).toBeTruthy();
  const kept = screen.getByRole('region', { name: 'Séances modifiées' });
  expect(kept.textContent).toContain('Séances que tu as modifiées : gardées');
  expect(kept.textContent).toContain('Seuil : 2×10’ déplacé');
  // Sessions by their kind, the kept one marked; the week says what it gave up.
  expect(screen.getByText('Course compromise')).toBeTruthy();
  expect(screen.getByText('Course clé')).toBeTruthy();
  expect(screen.getByText('· gardée')).toBeTruthy();
  expect(screen.getByText('1 séance retirée')).toBeTruthy();
  expect(screen.getByText(/Séance « Footing » retirée/)).toBeTruthy();
});

it('keeps a race preview as it was: no structure, no level', async () => {
  const road: PlanPreview = {
    goal,
    inputs: { weekly_minutes_now: 175, sessions_per_week: 4, rest_days: [0], vdot: 50 },
    summary: [],
    weeks: [{ ...preview.weeks[0], sessions: [{ ...preview.weeks[0].sessions[0], tags: [], kind: null }], dropped: [] }],
  };
  vi.spyOn(goalsApi, 'previewPlan').mockResolvedValue(road);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PlanPreviewModal goal={goal} onClose={() => {}} />
    </QueryClientProvider>
  );
  expect(await screen.findByText(/Départ : 175 min\/sem · 4 séances\/sem · repos lun\. · VDOT 50/)).toBeTruthy();
  expect(screen.queryByText(/Niveau/)).toBeNull();
  expect(screen.queryByRole('region', { name: 'Structure de la semaine' })).toBeNull();
  expect(screen.getByText('Fractionné')).toBeTruthy();
  client.clear();
});

it('creates a Hyrox goal with its division, format, category and equipment', async () => {
  vi.spyOn(goalsApi, 'list').mockResolvedValue([]);
  const create = vi.spyOn(goalsApi, 'create').mockResolvedValue({ ...goal, goal_type: 'hyrox' });
  const client = renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: /Ajouter un objectif/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Hyrox' }));
  fireEvent.change(screen.getByPlaceholderText('Hyrox Paris'), { target: { value: 'Hyrox Paris' } });
  fireEvent.change(screen.getByLabelText('Date du Hyrox'), { target: { value: '2027-03-20' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ajouter le Hyrox' }));
  expect(screen.getByRole('alert').textContent).toBe('Choisis la catégorie : Hommes, Femmes ou Mixte.');
  fireEvent.click(screen.getByRole('button', { name: 'Pro' }));
  fireEvent.click(screen.getByRole('button', { name: 'Femmes' }));
  // Equipment: a choice clears « Aucun », « Aucun » clears the rest.
  fireEvent.click(screen.getByRole('button', { name: 'Rameur' }));
  fireEvent.click(screen.getByRole('button', { name: 'Traîneau (poussée et tirage)' }));
  expect(screen.getByRole('button', { name: 'Aucun' }).getAttribute('aria-pressed')).toBe('false');
  fireEvent.change(screen.getByPlaceholderText('1:15:00'), { target: { value: '1:12:30' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ajouter le Hyrox' }));
  await waitFor(() =>
    expect(create.mock.calls[0][0]).toEqual({
      name: 'Hyrox Paris',
      race_date: '2027-03-20',
      target_time_sec: 4350,
      priority: 'A',
      goal_type: 'hyrox',
      details: { division: 'pro', format: 'solo', category: 'women', equipment: ['sled', 'rower'] },
    })
  );
  client.clear();
});

it('offers the mixed category in Open doubles only', async () => {
  vi.spyOn(goalsApi, 'list').mockResolvedValue([]);
  const client = renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: /Ajouter un objectif/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Hyrox' }));
  const mixed = screen.getByRole('button', { name: 'Mixte' }) as HTMLButtonElement;
  expect(mixed.disabled).toBe(true);
  expect(screen.getByText('Mixte se court en duo.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Duo' }));
  expect(mixed.disabled).toBe(false);
  fireEvent.click(mixed);
  expect(mixed.getAttribute('aria-pressed')).toBe('true');
  // Pro: no mixed category either, the choice goes.
  fireEvent.click(screen.getByRole('button', { name: 'Pro' }));
  expect(mixed.disabled).toBe(true);
  expect(mixed.getAttribute('aria-pressed')).toBe('false');
  expect(screen.getByText('Mixte se court en Open.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  fireEvent.click(mixed);
  expect(mixed.getAttribute('aria-pressed')).toBe('true');
  // Back to solo: the mixed choice goes, it would be refused.
  fireEvent.click(screen.getByRole('button', { name: 'Solo' }));
  expect(mixed.disabled).toBe(true);
  expect(mixed.getAttribute('aria-pressed')).toBe('false');
  client.clear();
});

it('creates a hybrid block ending on the Sunday of its last week from next Monday', async () => {
  freezeToday();
  vi.spyOn(goalsApi, 'list').mockResolvedValue([]);
  const create = vi.spyOn(goalsApi, 'create').mockRejectedValueOnce(
    new Error('API Error 422: {"detail":"La fin du bloc doit tomber entre le 20/12/2026 et le 03/01/2027 pour un bloc de 8 semaines."}')
  );
  const client = renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: /Ajouter un objectif/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Bloc hybride' }));
  expect(screen.getByText('Du lundi 26 octobre au dimanche 17 janvier 2027')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '8 semaines' }));
  expect(screen.getByText('Du lundi 26 octobre au dimanche 20 décembre 2026')).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText('Bloc hybride d’hiver'), { target: { value: 'Bloc hiver' } });
  fireEvent.click(screen.getByRole('button', { name: 'Wall ball' }));
  // Its category sets the stations' Open loads; a block has no mixed one.
  expect(screen.queryByRole('button', { name: 'Mixte' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Femmes' }));
  fireEvent.click(screen.getByRole('button', { name: 'Créer le bloc' }));
  await waitFor(() =>
    expect(create.mock.calls[0][0]).toEqual({
      name: 'Bloc hiver',
      race_date: '2026-12-20',
      goal_type: 'hybrid',
      details: { weeks: 8, equipment: ['wall_ball'], category: 'women' },
    })
  );
  // The server's French refusal shows under the form.
  expect((await screen.findByRole('alert')).textContent).toBe(
    'La fin du bloc doit tomber entre le 20/12/2026 et le 03/01/2027 pour un bloc de 8 semaines.'
  );
  client.clear();
});

it('edits a started block: its length stays, its end moves up to two weeks later', async () => {
  freezeToday();
  const block: Goal = {
    ...goal,
    id: 4,
    name: 'Bloc automne',
    race_date: '2026-11-29', // started Monday 5 October
    distance_km: 0,
    target_time_sec: null,
    goal_type: 'hybrid',
    details: { division: 'open', format: 'solo', category: null, equipment: ['none'], weeks: 8 },
  };
  vi.spyOn(goalsApi, 'list').mockResolvedValue([block]);
  const update = vi.spyOn(goalsApi, 'update').mockResolvedValue(block);
  const client = renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: 'Modifier Bloc automne' }));
  expect(screen.getByText('Le bloc a commencé : sa durée ne change plus.')).toBeTruthy();
  expect((screen.getByRole('button', { name: '12 semaines' }) as HTMLButtonElement).disabled).toBe(true);
  // An equipment edit sends no date.
  fireEvent.click(screen.getByRole('button', { name: 'SkiErg' }));
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update.mock.calls[0]).toEqual([
    4,
    {
      name: 'Bloc automne',
      details: { division: 'open', format: 'solo', category: null, weeks: 8, equipment: ['ski_erg'] },
    },
  ]);
  fireEvent.click(await screen.findByRole('button', { name: 'Modifier Bloc automne' }));
  fireEvent.click(screen.getByRole('button', { name: '+2 semaines' }));
  expect(screen.getByText('Fin le dimanche 13 décembre 2026')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update.mock.calls[1][1]).toMatchObject({ race_date: '2026-12-13' });
  client.clear();
});

it('clears a stored Pro mixed category on edit instead of showing it disabled', async () => {
  const stored: Goal = {
    ...goal,
    id: 6,
    name: 'Hyrox Lyon',
    race_date: '2027-03-20',
    distance_km: 8,
    goal_type: 'hyrox',
    details: { division: 'pro', format: 'doubles', category: 'mixed', equipment: ['sled'], weeks: 12 },
  };
  vi.spyOn(goalsApi, 'list').mockResolvedValue([stored]);
  const update = vi.spyOn(goalsApi, 'update').mockResolvedValue(stored);
  const client = renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: 'Modifier Hyrox Lyon' }));
  const mixed = screen.getByRole('button', { name: 'Mixte' }) as HTMLButtonElement;
  expect(mixed.disabled).toBe(true);
  expect(mixed.getAttribute('aria-pressed')).toBe('false');
  expect(screen.getByText('Mixte se court en Open.')).toBeTruthy();
  // Saving asks for a category the server accepts.
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  expect(screen.getByRole('alert').textContent).toBe('Choisis la catégorie : Hommes, Femmes ou Mixte.');
  expect(update).not.toHaveBeenCalled();
  client.clear();
});

it('resizes a block not started yet from its own first Monday', async () => {
  freezeToday();
  const block: Goal = {
    ...goal,
    id: 5,
    name: 'Bloc hiver',
    race_date: '2027-01-31', // 12 weeks from Monday 9 November
    distance_km: 0,
    target_time_sec: null,
    goal_type: 'hybrid',
    details: { division: 'open', format: 'solo', category: 'men', equipment: ['none'], weeks: 12 },
  };
  vi.spyOn(goalsApi, 'list').mockResolvedValue([block]);
  const update = vi.spyOn(goalsApi, 'update').mockResolvedValue(block);
  const client = renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: 'Modifier Bloc hiver' }));
  expect((screen.getByRole('button', { name: 'Hommes' }) as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: '8 semaines' }));
  // Still from 9 November, not re-anchored on next Monday.
  expect(screen.getByText('Du lundi 9 novembre au dimanche 3 janvier 2027')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update.mock.calls[0][1]).toMatchObject({ race_date: '2027-01-03', details: { weeks: 8, category: 'men' } });
  client.clear();
});

it('creates a goal from a distance chip and an h:mm:ss target', async () => {
  vi.spyOn(goalsApi, 'list').mockResolvedValue([]);
  const create = vi.spyOn(goalsApi, 'create').mockResolvedValue(goal);
  const client = renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: /Ajouter un objectif/ }));
  // A race is the default type: its form and payload are unchanged.
  expect(screen.getByRole('button', { name: 'Course' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.change(screen.getByPlaceholderText('Semi de Paris'), { target: { value: 'Semi de Paris' } });
  fireEvent.change(document.querySelector('input[type="date"]')!, { target: { value: '2027-03-07' } });
  fireEvent.click(screen.getByRole('button', { name: '21,1' }));
  fireEvent.change(screen.getByPlaceholderText('1:45:00'), { target: { value: '1:4' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ajouter la course' }));
  expect(screen.getByRole('alert').textContent).toBe('Temps visé au format h:mm:ss.');
  fireEvent.change(screen.getByPlaceholderText('1:45:00'), { target: { value: '1:45:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'B' }));
  fireEvent.click(screen.getByRole('button', { name: 'Ajouter la course' }));
  await waitFor(() =>
    expect(create.mock.calls[0][0]).toEqual({
      name: 'Semi de Paris',
      race_date: '2027-03-07',
      distance_km: 21.1,
      target_time_sec: 6300,
      priority: 'B',
    })
  );
  client.clear();
});
