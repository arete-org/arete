// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { tipsApi, type DailyTip } from '@/lib/api';
import { BriefingCard } from './BriefingCard';

const tip: DailyTip = {
  status: 'ready', tip: 'Footing facile.', priority: 'info', source: 'rules', generated_at: '2026-10-14T07:00:00',
  updated_after_sync: false, id: 41, first_written_at: null, reaction: null, reaction_comment: null,
};
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function mount(value = tip, writing = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><BriefingCard tip={value} writing={writing} stalled={false} refresh={() => {}} /></QueryClientProvider>);
}

it('opens a briefing from its title or action, without writing feedback or sending a message', () => {
  const react = vi.spyOn(tipsApi, 'react');
  const asked = vi.fn();
  window.addEventListener('arete:coach-discuss', asked);
  mount();
  expect(screen.getByText('Écrit à 7 h · calculé à partir de tes métriques')).toBeTruthy();
  expect(screen.queryByRole('group', { name: /avis/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /^Briefing du jour/ }));
  fireEvent.click(screen.getByRole('button', { name: 'En parler avec Chiron' }));
  window.removeEventListener('arete:coach-discuss', asked);
  expect(asked).toHaveBeenCalledTimes(2);
  expect((asked.mock.calls[0][0] as CustomEvent).detail).toEqual({ kind: 'briefing', id: 41 });
  expect(react).not.toHaveBeenCalled();
});

it('reads history on demand and opens the selected historical briefing', async () => {
  const history = vi.spyOn(tipsApi, 'history').mockResolvedValue([
    { id: 40, date: '2026-10-13', tip: 'Sortie longue tranquille.', source: 'agent', generated_at: null, reaction: 'up', reaction_comment: null },
  ]);
  const asked = vi.fn();
  window.addEventListener('arete:coach-discuss', asked);
  mount();
  expect(history).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Briefings précédents' }));
  fireEvent.click(await screen.findByRole('button', { name: /mardi 13 octobre/ }));
  window.removeEventListener('arete:coach-discuss', asked);
  expect((asked.mock.calls[0][0] as CustomEvent).detail).toEqual({ kind: 'briefing', id: 40 });
});

it('does not open a thread before a stored briefing is ready', () => {
  mount({ ...tip, id: null, tip: null, status: 'pending' }, true);
  expect((screen.getByRole('button', { name: /^Briefing du jour/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toContain('Chiron écrit');
});
