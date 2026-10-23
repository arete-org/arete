// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { planApi } from '@/lib/api';
import { qk } from '@/lib/queryKeys';
import type { ReviewProposal, WeeklyReview } from '@/types';
import { ReviewProposals, WeeklyReviewPanel } from './WeeklyReviewPanel';

const proposal = (index: number, over: Partial<ReviewProposal> = {}): ReviewProposal => ({
  index,
  planned_session_id: 10 + index,
  date: '2026-10-1' + index,
  session: `Fractionné 50 min #${index}`,
  change: { session_type: 'endurance' },
  before: { session_type: 'intervals' },
  reason: `Fraîcheur à -22 : raison ${index}.`,
  ...over,
});

const review: WeeklyReview = {
  id: 4,
  week_start: '2026-09-28',
  text: 'Semaine chargée.',
  source: 'rules',
  proposals: [proposal(0), proposal(1), proposal(2)],
  applied: [],
  created_at: '2026-10-05T07:00:00',
  applied_at: null,
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

const renderPanel = () =>
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WeeklyReviewPanel />
      </MemoryRouter>
    </QueryClientProvider>
  );

it('marks applied proposals, locks them and reports stale ones', () => {
  const onToggle = vi.fn();
  render(
    <ReviewProposals
      proposals={[proposal(0), proposal(1), proposal(2)]}
      applied={[0]}
      stale={[2]}
      selected={[1]}
      onToggle={onToggle}
    />
  );
  const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
  expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([
    [true, true],
    [true, false],
    [false, false],
  ]);
  expect(screen.getAllByText('Appliquée')).toHaveLength(1);
  expect(screen.getByText('Séance modifiée depuis : proposition ignorée')).toBeTruthy();
  expect(screen.getByText('Fraîcheur à -22 : raison 1.')).toBeTruthy();
  fireEvent.click(boxes[2]);
  expect(onToggle).toHaveBeenCalledWith(2);
});

it('offers to write the review when there is none', async () => {
  vi.spyOn(planApi, 'getReview').mockResolvedValue(null);
  const write = vi.spyOn(planApi, 'writeReview').mockResolvedValue(review);
  renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: 'Faire le bilan' }));
  await waitFor(() => expect(write).toHaveBeenCalledWith(false));
  expect(await screen.findByText('Semaine chargée.')).toBeTruthy();
  expect(screen.getByText(/Calculé/)).toBeTruthy();
});

it('applies the ticked proposals and refreshes the planned sessions', async () => {
  vi.spyOn(planApi, 'getReview').mockResolvedValue(review);
  const apply = vi.spyOn(planApi, 'applyReview').mockResolvedValue({ applied: [0], stale: [2] });
  client.setQueryData(qk.planned(), []);
  renderPanel();
  const boxes = (await screen.findAllByRole('checkbox')) as HTMLInputElement[];
  expect(boxes.every((b) => b.checked)).toBe(true);
  fireEvent.click(boxes[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Appliquer' }));
  await waitFor(() => expect(apply).toHaveBeenCalledWith(4, [0, 2], '2026-10-05T07:00:00'));
  expect(await screen.findByText('Séance modifiée depuis : proposition ignorée')).toBeTruthy();
  expect(client.getQueryState(qk.planned())?.isInvalidated).toBe(true);
});

it('rewrites the review on demand', async () => {
  vi.spyOn(planApi, 'getReview').mockResolvedValue(review);
  const write = vi
    .spyOn(planApi, 'writeReview')
    .mockResolvedValue({ ...review, id: 5, source: 'agent', text: 'Nouveau bilan.' });
  renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: /Refaire le bilan/ }));
  await waitFor(() => expect(write).toHaveBeenCalledWith(true, 4));
  expect(await screen.findByText('Nouveau bilan.')).toBeTruthy();
  expect(screen.getByText(/Le coach/)).toBeTruthy();
});
