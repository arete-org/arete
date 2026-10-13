// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { coachApi, type Proposal } from '@/lib/coachToday';
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
