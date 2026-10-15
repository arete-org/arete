// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { planApi } from '@/lib/api';
import { qk } from '@/lib/queryKeys';
import type { ReviewAccepted, ReviewProposal, ReviewWeek, WeeklyReview } from '@/types';
import { WeekReviewPage } from './WeekReview';

const proposal = (index: number, date: string): ReviewProposal => ({
  index,
  planned_session_id: 20 + index,
  date,
  session: index === 0 ? 'intervals 50 min Z4' : 'long_run 90 min Z2',
  change: {},
  before: {},
  reason: `Raison ${index}.`,
});

const review: WeeklyReview = {
  id: 7,
  week_start: '2026-10-12',
  text: 'Semaine tenue : 4 séances sur 5.',
  source: 'agent',
  proposals: [proposal(0, '2026-10-20'), proposal(1, '2026-10-25')],
  applied: [],
  created_at: '2026-10-18T16:10:00',
  applied_at: null,
};
const week: ReviewWeek = {
  today: '2026-10-18',
  review,
  recap: {
    week_start: '2026-10-12', week_end: '2026-10-18', planned: 5, completed: 4,
    minutes_done: 240, minutes_planned: 300, adherence: 0.8, tsb: -8,
  },
};

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

const mount = () =>
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/planning/semaine']}>
        <WeekReviewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

it('shows last week in four numbers and the coach’s words', async () => {
  vi.spyOn(planApi, 'getReviewWeek').mockResolvedValue(week);
  mount();
  expect(await screen.findByText('Semaine tenue : 4 séances sur 5.')).toBeTruthy();
  expect(screen.getByText('4/5')).toBeTruthy();
  expect(screen.getByText('4h00')).toBeTruthy();
  expect(screen.getByText('sur 5h00 prévues')).toBeTruthy();
  expect(screen.getByText('80 %')).toBeTruthy();
  expect(screen.getByText('-8')).toBeTruthy();
  expect(screen.getByText('Le mot du coach')).toBeTruthy();
  // The server's session types read in French.
  expect(screen.getByText('Fractionné 50 min Z4')).toBeTruthy();
});

it('accepts the ticked proposals only and reports each outcome from the server', async () => {
  vi.spyOn(planApi, 'getReviewWeek').mockResolvedValue(week);
  const answer: ReviewAccepted = {
    applied: [],
    stale: [1],
    garmin: {
      state: 'done',
      sessions: [
        { planned_session_id: 21, date: '2026-10-25', session_type: 'long_run', outcome: 'already' },
        { planned_session_id: 30, date: '2026-10-22', session_type: 'tempo', outcome: 'failed' },
      ],
    },
    calendar: 'synced',
  };
  const accept = vi.spyOn(planApi, 'acceptReview').mockResolvedValue(answer);
  client.setQueryData(qk.planned(), []);
  mount();
  const boxes = (await screen.findAllByRole('checkbox')) as HTMLInputElement[];
  expect(boxes.map((b) => b.checked)).toEqual([true, true]);
  fireEvent.click(boxes[0]); // keep the intervals as they are
  fireEvent.click(screen.getByRole('button', { name: 'Accepter (1)' }));
  await waitFor(() => expect(accept).toHaveBeenCalledWith(7, [1]));
  const outcome = await screen.findByRole('status');
  expect(within(outcome).getByText('Aucune proposition appliquée : le planning reste tel quel.')).toBeTruthy();
  expect(within(outcome).getByText(/1 proposition ignorée/)).toBeTruthy();
  expect(within(outcome).getByText(/Sortie longue : déjà sur Garmin, inchangée/)).toBeTruthy();
  expect(within(outcome).getByText(/Seuil : échec de l’envoi/)).toBeTruthy();
  expect(within(outcome).getByText('Calendrier : à jour.')).toBeTruthy();
  // The stale one is marked in the list, and the planned sessions are read again.
  expect(screen.getByText('Séance modifiée depuis : proposition ignorée')).toBeTruthy();
  expect(client.getQueryState(qk.planned())?.isInvalidated).toBe(true);
});

it('keeps the focus on the page when « Accepter » leaves with the last proposal', async () => {
  // Read again after the answer: the server has both applied.
  const accepted = { ...week, review: { ...review, applied: [0, 1], applied_at: '2026-10-18T18:30:00' } };
  vi.spyOn(planApi, 'getReviewWeek').mockResolvedValueOnce(week).mockResolvedValue(accepted);
  vi.spyOn(planApi, 'acceptReview').mockResolvedValue({
    applied: [0, 1], stale: [], garmin: { state: 'disabled', sessions: [] }, calendar: 'disabled',
  });
  mount();
  const button = await screen.findByRole('button', { name: 'Accepter (2)' });
  button.focus();
  fireEvent.click(button);
  const heading = await screen.findByRole('heading', { name: 'Semaine acceptée' });
  await waitFor(() => expect(screen.queryByRole('button', { name: /^Accepter/ })).toBeNull());
  expect(document.activeElement).toBe(heading);
  expect(screen.getByText('Montre : envoi automatique désactivé (Réglages › Coach).')).toBeTruthy();
  expect(screen.getByText('2 propositions appliquées au planning.')).toBeTruthy();
});

it('opens the coach with the review as context, the composer untouched', async () => {
  vi.spyOn(planApi, 'getReviewWeek').mockResolvedValue(week);
  const accept = vi.spyOn(planApi, 'acceptReview');
  const discussed: unknown[] = [];
  const listen = (event: Event) => discussed.push((event as CustomEvent).detail);
  window.addEventListener('arete:coach-discuss', listen);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Ajuster avec le coach' }));
  window.removeEventListener('arete:coach-discuss', listen);
  expect(discussed).toEqual([{ kind: 'review', id: 7 }]);
  expect(accept).not.toHaveBeenCalled(); // never applied without the click
});

it('says when the week has no review yet', async () => {
  vi.spyOn(planApi, 'getReviewWeek').mockResolvedValue({ today: '2026-10-17', review: null, recap: null });
  mount();
  expect(await screen.findByText(/le coach l’écrit dimanche soir/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Faire le bilan maintenant' })).toBeTruthy();
});
