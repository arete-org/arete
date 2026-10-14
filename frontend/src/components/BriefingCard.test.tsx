// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { tipsApi, type DailyTip } from '@/lib/api';
import { qk } from '@/lib/queryKeys';
import { BriefingCard } from './BriefingCard';

const DAY = '2026-10-14';
const tip: DailyTip = {
  status: 'ready', tip: 'Footing facile.', priority: 'info', source: 'rules', generated_at: '2026-10-14T07:00:00',
  updated_after_sync: false, id: 41, first_written_at: null, reaction: null, reaction_comment: null,
};

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData([...qk.tipDaily, DAY], tip);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

/** The card as the dashboard renders it: from the day's cached briefing, as useDailyTip reads it. */
function Card() {
  const { data } = useQuery({ queryKey: [...qk.tipDaily, DAY], queryFn: () => tip, enabled: false });
  return <BriefingCard tip={data} day={DAY} writing={false} stalled={false} refresh={() => {}} />;
}
const mount = () => render(<QueryClientProvider client={client}><Card /></QueryClientProvider>);

it('stores a reaction on the briefing, then an optional word with it', async () => {
  const react = vi.spyOn(tipsApi, 'react').mockImplementation(async (id, reaction, comment) => ({ id, reaction, reaction_comment: comment ?? null }));
  mount();
  expect(screen.getByText('Écrit à 7 h · calculé à partir de tes métriques')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Utile' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Utile' }).getAttribute('aria-pressed')).toBe('true'));
  expect(react).toHaveBeenLastCalledWith(41, 'up', undefined);

  fireEvent.change(screen.getByLabelText(/Un mot sur ce briefing/), { target: { value: ' Trop court ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Envoyer' }));
  await screen.findByText('Ton mot : Trop court');
  expect(react).toHaveBeenLastCalledWith(41, 'up', 'Trop court');

  // Changing the answer keeps the word; choosing it again withdraws it.
  fireEvent.click(screen.getByRole('button', { name: 'Pas utile' }));
  await waitFor(() => expect(react).toHaveBeenLastCalledWith(41, 'down', 'Trop court'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Pas utile' }).getAttribute('aria-pressed')).toBe('true'));
  fireEvent.click(screen.getByRole('button', { name: 'Pas utile' }));
  await waitFor(() => expect(react).toHaveBeenLastCalledWith(41, null, undefined));
  await waitFor(() => expect(screen.queryByText(/Ton mot/)).toBeNull());
});

it('says a reaction failed and retries only when asked', async () => {
  const react = vi.spyOn(tipsApi, 'react').mockRejectedValueOnce(new Error('Réseau indisponible'));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Pas utile' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Avis non enregistré/);
  expect(react).toHaveBeenCalledTimes(1);
  react.mockResolvedValueOnce({ id: 41, reaction: 'down', reaction_comment: null });
  fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
  await waitFor(() => expect(react).toHaveBeenCalledTimes(2));
  expect(react).toHaveBeenLastCalledWith(41, 'down', undefined);
});

it('reads the previous briefings only when they are opened', async () => {
  const history = vi.spyOn(tipsApi, 'history').mockResolvedValue([
    { id: 40, date: '2026-10-13', tip: 'Sortie longue tranquille.', source: 'agent', generated_at: null, reaction: 'up', reaction_comment: null },
  ]);
  mount();
  expect(history).not.toHaveBeenCalled();
  const toggle = screen.getByRole('button', { name: 'Briefings précédents' });
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(await screen.findByText('Sortie longue tranquille.')).toBeTruthy();
  expect(screen.getByText(/mardi 13 octobre/)).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Ton avis : utile' })).toBeTruthy();
  expect(history).toHaveBeenCalledTimes(1);
});

it('asks the coach about this briefing without sending anything', async () => {
  const react = vi.spyOn(tipsApi, 'react');
  const asked = vi.fn();
  window.addEventListener('arete:coach-discuss', asked);
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Demander au coach' }));
  window.removeEventListener('arete:coach-discuss', asked);
  expect(asked).toHaveBeenCalledTimes(1);
  expect((asked.mock.calls[0][0] as CustomEvent).detail).toEqual({ kind: 'briefing', id: 41 });
  expect(react).not.toHaveBeenCalled();
});

it('lets a word come later without withdrawing the reaction', async () => {
  const react = vi.spyOn(tipsApi, 'react').mockImplementation(async (id, reaction, comment) => ({ id, reaction, reaction_comment: comment ?? null }));
  client.setQueryData([...qk.tipDaily, DAY], { ...tip, reaction: 'up' });
  mount();
  expect(screen.queryByLabelText(/Un mot sur ce briefing/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Ajouter un mot' }));
  expect(react).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Utile' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.change(screen.getByLabelText(/Un mot sur ce briefing/), { target: { value: 'Plus tard.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Envoyer' }));
  await screen.findByText('Ton mot : Plus tard.');
  expect(react).toHaveBeenCalledTimes(1);
  expect(react).toHaveBeenLastCalledWith(41, 'up', 'Plus tard.');
  expect(screen.queryByRole('button', { name: 'Ajouter un mot' })).toBeNull();
});
