// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { coachApi, coachTodayKey, type Proposal } from '@/lib/coachToday';
import { CoachTodayPanel } from './CoachToday';

const proposal = (id: number, over: Partial<Proposal>): Proposal => ({
  id,
  date: '2026-10-13',
  planned_session_id: 100 + id,
  decision: 'replace_easy',
  reason: 'Préparation Garmin 49/100 : la séance fractionné 60 min devient 30 min de récupération en Z1.',
  readiness_score: 49,
  readiness_source: 'garmin_training',
  acwr: 1,
  original: { session_type: 'intervals', target_duration_min: 60 },
  adapted: { session_type: 'recovery', target_duration_min: 30, target_hr_zone: 'Z1' },
  applied_at: null,
  reverted_at: null,
  created_at: null,
  state: 'pending',
  revision: 1,
  session_revision: 1,
  readiness_measured_on: '2026-10-13',
  ...over,
});

const key = proposal(7, { revision: 2 });
const rest = proposal(8, { decision: 'rest', original: { session_type: 'endurance', target_duration_min: 45 }, adapted: null, revision: 3 });

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

const renderPanel = (group: Proposal[], members = group.map(p => ({ id: p.id, revision: p.revision }))) => {
  vi.spyOn(coachApi, 'today').mockResolvedValue({ date: '2026-10-13', items: [{ kind: 'proposal', record: group[0], group, members }], remaining: 0, briefing: null });
  return render(<QueryClientProvider client={client}><CoachTodayPanel /></QueryClientProvider>);
};

it('shows a low day as one card and answers for every session of it', async () => {
  const respond = vi.spyOn(coachApi, 'proposal').mockResolvedValue({ ...key, state: 'applied' });
  renderPanel([key, rest]);
  expect(await screen.findByText('Fractionné · 60 min → Récupération · 30 min · Z1')).toBeTruthy();
  expect(screen.getByText('Endurance · 45 min → Repos')).toBeTruthy();
  expect(screen.getAllByRole('article')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Garder ma séance' }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith(7, 2, 'keep', [{ id: 8, revision: 3 }]));
});

it('blocks only applying when one session of the day changed', async () => {
  const respond = vi.spyOn(coachApi, 'proposal').mockResolvedValue({ ...key, state: 'dismissed' });
  renderPanel([key, { ...rest, state: 'stale' }]);
  expect(await screen.findByText(/Proposition périmée/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Appliquer' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Pas maintenant' }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith(7, 2, 'snooze', [{ id: 8, revision: 3 }]));
});

it('answers for a member hidden by an earlier snooze', async () => {
  const respond = vi.spyOn(coachApi, 'proposal').mockResolvedValue({ ...key, state: 'applied' });
  renderPanel([key], [{ id: 7, revision: 2 }, { id: 8, revision: 3 }]);
  expect(await screen.findByText('Prévu : Fractionné · 60 min')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Appliquer' }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith(7, 2, 'apply', [{ id: 8, revision: 3 }]));
});

it('keeps the single-session card as it was', async () => {
  const respond = vi.spyOn(coachApi, 'proposal').mockResolvedValue({ ...key, state: 'applied' });
  renderPanel([key]);
  expect(await screen.findByText('Prévu : Fractionné · 60 min')).toBeTruthy();
  expect(screen.getByText('Proposé : Récupération · 30 min · Z1')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Appliquer' }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith(7, 2, 'apply', []));
});

it('shows the card the dashboard seeded without a request of its own', async () => {
  // The app's default: a seed younger than 30 s is fresh.
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  const today = vi.spyOn(coachApi, 'today');
  const { rerender } = render(<QueryClientProvider client={client}><CoachTodayPanel enabled={false} /></QueryClientProvider>);
  expect(screen.getByRole('status').textContent).toBe('Chargement du suivi…');
  client.setQueryData(coachTodayKey, { date: '2026-10-13', items: [{ kind: 'proposal', record: key, group: [key], members: [] }], remaining: 0, briefing: null });
  rerender(<QueryClientProvider client={client}><CoachTodayPanel enabled /></QueryClientProvider>);
  expect(await screen.findByText('Prévu : Fractionné · 60 min')).toBeTruthy();
  expect(today).not.toHaveBeenCalled();
});

it('checks an uncertain answer with a read of its own while the card waits for the dashboard', async () => {
  vi.spyOn(coachApi, 'proposal').mockRejectedValue(new Error('timeout'));
  const today = vi.spyOn(coachApi, 'today').mockResolvedValue({ date: '2026-10-13', items: [], remaining: 0, briefing: null });
  client.setQueryData(coachTodayKey, { date: '2026-10-13', items: [{ kind: 'proposal', record: key, group: [key], members: [] }], remaining: 0, briefing: null });
  render(<QueryClientProvider client={client}><CoachTodayPanel enabled={false} refetchOnFocus={false} /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Appliquer' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Vérifier l’état' }));
  await waitFor(() => expect(today).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Vérifier l’état' })).toBeNull());
});

const missedMove = proposal(9, {
  decision: 'move',
  readiness_source: 'missed',
  readiness_score: null,
  readiness_measured_on: null,
  reason: 'Séance manquée aujourd’hui : la séance fractionné 60 min passe à jeudi 15 octobre, premier jour libre sans séance dure la veille ni le lendemain.',
  adapted: { date: '2026-10-15' },
  revision: 1,
});

it('offers a missed session’s move in one tap, then reports it with Garmin apart', async () => {
  const respond = vi.spyOn(coachApi, 'proposal').mockResolvedValue({ ...missedMove, state: 'applied', garmin: 'sent' });
  renderPanel([missedMove]);
  expect(await screen.findByText(/Séance manquée ·/)).toBeTruthy();
  expect(screen.getByText('Proposé : Déplacée à jeudi 15 octobre')).toBeTruthy();
  expect(screen.getByText(/Aucune activité enregistrée aujourd’hui/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Pas maintenant' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Déplacer' }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith(9, 1, 'apply', []));
  const status = await screen.findByRole('status');
  expect(status.textContent).toContain('Séance déplacée à jeudi 15 octobre.');
  expect(status.textContent).toContain('Garmin : la séance est à jour sur ta montre.');
  expect(document.activeElement).toBe(status);
});

it('declines a missed session’s drop in one tap', async () => {
  const drop = { ...missedMove, decision: 'drop' as const, adapted: null };
  const respond = vi.spyOn(coachApi, 'proposal').mockResolvedValue({ ...drop, state: 'dismissed', garmin: 'unchanged' });
  renderPanel([drop]);
  expect(await screen.findByText('Proposé : Laissée de côté')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Laisser de côté' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Non merci' }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith(9, 1, 'keep', []));
  expect((await screen.findByRole('status')).textContent).toBe('C’est noté : rien ne change.');
});

it('home exposes the reason before review and preserves the grouped apply contract', async () => {
  const { MemoryRouter } = await import('react-router-dom');
  const respond = vi.spyOn(coachApi, 'proposal').mockResolvedValue({ ...key, state: 'applied' });
  client.setQueryData(coachTodayKey, { date: key.date, items: [{ kind: 'proposal', record: key, group: [key, rest], members: [{ id: key.id, revision: 2 }, { id: rest.id, revision: 3 }] }], remaining: 2, briefing: null });
  render(<MemoryRouter><QueryClientProvider client={client}><CoachTodayPanel enabled={false} home /></QueryClientProvider></MemoryRouter>);
  expect(screen.getByText('Une proposition à examiner')).toBeTruthy();
  expect(screen.getAllByText(key.reason).length).toBeGreaterThan(0);
  expect(respond).not.toHaveBeenCalled();
  const review = document.querySelector('details')!;
  review.open = true;
  expect(screen.getByText('Fractionné · 60 min → Récupération · 30 min · Z1')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Appliquer' }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith(7, 2, 'apply', [{ id: 8, revision: 3 }]));
  expect(screen.getByRole('link', { name: 'Voir le suivi' }).getAttribute('href')).toBe('/follow-up');
});
