// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { settingsApi } from '@/lib/api';
import { coachApi } from '@/lib/coachToday';
import type { DashboardData } from '@/lib/dashboard';
import { gameApi, type Player } from '@/lib/gamification';
import { weeksAtGoalText } from '@/lib/fr';
import { DashboardPage } from './HUD';

const board: DashboardData = {
  date: '2026-10-14',
  planned: [],
  actual: [],
  strength: [],
  plan_today: { date: '2026-10-14', decisions: [] },
  next_goal: null,
  player_stats: {
    level: 0,
    weeks_at_goal: 30,
    weekly_goal_tss: 300,
    recent_weeks_at_goal: 9,
    recent_weeks: 12,
    hp: { current: 62, max: 100, label: 'Récupération', detail: 'Préparation à l’entraînement Garmin (ce matin)', source: 'garmin_training' },
    mp: { current: 57, max: 100, label: 'Forme', detail: 'TSB +4,2', source: 'model' },
    xp: { current: 120, max: 300, label: 'Charge de la semaine', detail: 'Objectif 6 séances', source: 'model' },
  },
  fitness: {
    ctl: 40, atl: 36, tsb: 4.2, form_zone: 'fresh', readiness_score: 62, readiness_level: 'good',
    readiness_source: 'garmin_training', readiness_measured_on: '2026-10-14', ramp_rate: null, days_analyzed: 30,
  },
  workload: {
    acwr: 1.12, acwr_zone: 'optimal', acwr_ewma: null, monotony: null, monotony_zone: 'unknown', strain: null,
    strain_zone: 'unknown', acute_load: 300, chronic_load: 260, days_analyzed: 20,
  },
  health: null,
  garmin_connected: false,
};

const player = {
  enabled: true, available: true, version: 1, athlete_class: 'sentinel', silhouette: 'balanced', equipped: 'base',
  xp: 1770, shards: 390, level: 6, rank: 'Adepte', in_level: 270, level_span: 600, sessions: 21, pending: 0,
  week: { sessions: 5, goal: 5, complete: true, timezone: 'Europe/Paris' },
  catalog: [], badges: [], history: [], has_more: false,
} satisfies Player;

vi.mock('@/lib/dashboard', () => ({ fetchDashboard: vi.fn(async () => board) }));
vi.mock('@/lib/dailyTip', () => ({
  useDailyTip: () => ({ tip: undefined, writing: false, stalled: false, refresh: () => {} }),
}));

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(settingsApi, 'get').mockResolvedValue({ display_name: 'Arthur' } as Awaited<ReturnType<typeof settingsApi.get>>);
  vi.spyOn(coachApi, 'today').mockResolvedValue({ date: '2026-10-14', items: [], remaining: 0, briefing: null });
  vi.spyOn(gameApi, 'snapshot').mockResolvedValue(player);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

async function mount(rpg: boolean) {
  vi.spyOn(gameApi, 'preference').mockResolvedValue({ enabled: rpg, opted_in: rpg, available: true, version: 1 });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
  await screen.findByText('Charge de la semaine');
  if (rpg) await screen.findByText('Niveau 6 · Adepte');
  else await vi.waitFor(() => expect(client.getQueryState(['game-preference'])?.status).toBe('success'));
}

it('speaks plain words without the RPG: no HP, MP, XP, player nor level', async () => {
  await mount(false);
  expect(screen.getByRole('heading', { name: 'MA FORME DU JOUR' })).toBeTruthy();
  const text = document.body.textContent ?? '';
  expect(text).not.toMatch(/\b(HP|MP|XP)\b/);
  expect(text).not.toMatch(/joueur/i);
  expect(text).not.toMatch(/Niveau/);
  // Each bar names itself and keeps its detail on screen (a title never shows on a phone).
  for (const label of ['Récupération', 'Forme', 'Charge de la semaine']) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByText('Préparation à l’entraînement Garmin (ce matin)')).toBeTruthy();
  expect(document.querySelector('[title]')).toBeNull();
  // Plain label first, the acronym as a secondary line, French decimals.
  expect(screen.getByText('Charge')).toBeTruthy();
  expect(screen.getByText('1,12')).toBeTruthy();
  expect(screen.getByText(/^ACWR/)).toBeTruthy();
  expect(screen.getByText('Fraîcheur')).toBeTruthy();
  expect(screen.getByText('+4,2')).toBeTruthy();
  expect(screen.getByText(/^TSB ·/)).toBeTruthy();
});

it('keeps the RPG tags with the game on, and a single level: the RPG one', async () => {
  await mount(true);
  expect(screen.getByRole('heading', { name: 'ÉTAT DU JOUEUR' })).toBeTruthy();
  for (const tag of ['HP', 'MP', 'TSS']) expect(screen.getByText(tag)).toBeTruthy();
  expect(screen.getAllByText(/Niveau/)).toHaveLength(1);
});

it('shows the regularity over the last twelve weeks, not a streak', async () => {
  await mount(false);
  expect(screen.getByText('9/12')).toBeTruthy();
  expect(screen.getByText('Régularité : 9 des 12 dernières semaines à l’objectif')).toBeTruthy();
  expect(weeksAtGoalText(3, 4)).toBe('3 des 4 dernières semaines à l’objectif');
  expect(weeksAtGoalText(0, 1)).toBe('Dernière semaine sous l’objectif');
});

it('offers one way to log a session and no duplicate quick links', async () => {
  await mount(false);
  expect(screen.getAllByRole('link', { name: 'Saisir une séance' })).toHaveLength(1);
  expect(screen.queryByRole('link', { name: /Voir le planning/ })).toBeNull();
  const refresh = screen.getByRole('button', { name: 'Actualiser le suivi' });
  expect(refresh.getAttribute('aria-describedby')).toBe('coach-prepare-hint');
  expect(within(document.body).getByText(/Rien ne change sans ton accord/)).toBeTruthy();
});
