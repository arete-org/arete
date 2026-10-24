// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { tipsApi, type PastBriefing } from '@/lib/api';
import { BriefingDiscussion } from './BriefingDiscussion';

vi.mock('./AgentMarkdown', () => ({ AgentMarkdown: ({ text }: { text: string }) => <p>{text}</p> }));
const briefing: PastBriefing = { id: 41, date: '2026-10-15', tip: 'Repos aujourd’hui.', source: 'agent', generated_at: null, reaction: 'up', reaction_comment: 'À garder.' };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><BriefingDiscussion id={41} /></QueryClientProvider>);
}
it('reads the complete briefing and shares the chat rating controls, preserving an old comment', async () => {
  vi.spyOn(tipsApi, 'briefing').mockResolvedValue(briefing);
  const react = vi.spyOn(tipsApi, 'react').mockResolvedValue({ id: 41, reaction: 'down', reaction_comment: 'À garder.' });
  mount();
  await screen.findByText(briefing.tip);
  expect(screen.getByText('Ton avis précédent : À garder.')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  const down = screen.getByRole('button', { name: 'Briefing peu utile' });
  expect(down.querySelector('svg')).toBeTruthy();
  fireEvent.click(down);
  await waitFor(() => expect(down.getAttribute('aria-pressed')).toBe('true'));
  expect(react).toHaveBeenCalledExactlyOnceWith(41, 'down', 'À garder.');
});
it('requires a read after an uncertain feedback write and never automatically retries it', async () => {
  const read = vi.spyOn(tipsApi, 'briefing').mockResolvedValue(briefing);
  const react = vi.spyOn(tipsApi, 'react').mockRejectedValue(new Error('Réseau indisponible'));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Briefing peu utile' }));
  await screen.findByRole('alert');
  expect((screen.getByRole('button', { name: 'Briefing peu utile' }) as HTMLButtonElement).disabled).toBe(true);
  read.mockResolvedValue({ ...briefing, reaction: 'down' });
  fireEvent.click(screen.getByRole('button', { name: 'Vérifier l’avis enregistré' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(screen.getByRole('button', { name: 'Briefing peu utile' }).getAttribute('aria-pressed')).toBe('true');
  expect(react).toHaveBeenCalledTimes(1);
});
it('reports a missing briefing and leaves retry explicit', async () => {
  const read = vi.spyOn(tipsApi, 'briefing').mockRejectedValue(new Error('Briefing introuvable.'));
  mount();
  expect((await screen.findByRole('alert')).textContent).toContain('Briefing introuvable');
  expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValue(briefing);
  fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
  await screen.findByText(briefing.tip);
});

it('renders only the evidence stored with the selected briefing and dates its source', async () => {
  vi.spyOn(tipsApi, 'briefing').mockResolvedValue({ ...briefing, evidence: [
    { label: 'Préparation', value: '18 / 100', source: 'Préparation Garmin', measured_on: '2026-10-14' },
  ] });
  mount();
  await screen.findByText('18 / 100');
  expect(screen.getByText('Préparation Garmin · 14 octobre')).toBeTruthy();
  expect(screen.queryByText(/Aucune mesure source conservée/)).toBeNull();
});

it('does not replace missing historical evidence with today’s metrics', async () => {
  vi.spyOn(tipsApi, 'briefing').mockResolvedValue(briefing);
  mount();
  await screen.findByText(/Aucune mesure source conservée/);
  expect(screen.queryByRole('definition')).toBeNull();
});
