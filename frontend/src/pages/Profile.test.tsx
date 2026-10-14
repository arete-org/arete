// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gameApi, syncGame, type Player } from '@/lib/gamification';
import { ProfilePage } from './Profile';
import { GamificationTab } from './settings/GamificationTab';

vi.mock('@/lib/api', () => ({
  settingsApi: { get: vi.fn(async () => ({ display_name: 'Arthur' })) },
  strengthApi: {},
  analyticsApi: {},
}));
vi.mock('@/lib/gamification', async (original) => {
  const module = await original<typeof import('@/lib/gamification')>();
  Object.assign(module.gameApi, {
    preference: vi.fn(),
    sync: vi.fn(),
    purchase: vi.fn(),
    equip: vi.fn(),
    toggle: vi.fn(),
    snapshot: vi.fn(),
  });
  return module;
});
const fixture: Player = {
  enabled: true,
  available: true,
  version: 1,
  athlete_class: 'sentinel',
  silhouette: 'balanced',
  equipped: 'base',
  xp: 1770,
  shards: 390,
  level: 6,
  rank: 'Adepte',
  in_level: 270,
  level_span: 600,
  sessions: 21,
  pending: 0,
  week: { sessions: 5, goal: 5, complete: true, timezone: 'Europe/Paris' },
  catalog: [
    { id: 'eclipse', name: 'Éclipse', price: 300, level: 1, owned: false },
  ],
  badges: [],
  history: [],
  has_more: false,
};
function mount(node: React.ReactNode, path = '/profile') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
    </QueryClientProvider>
  );
  return client;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gameApi.preference).mockResolvedValue({
    enabled: true,
    opted_in: true,
    available: true,
    version: 1,
  });
  vi.mocked(gameApi.snapshot).mockResolvedValue(structuredClone(fixture));
});
afterEach(cleanup);
it('gates direct profile links without projecting rewards when opted out', async () => {
  vi.mocked(gameApi.preference).mockResolvedValue({
    enabled: false,
    opted_in: false,
    available: true,
    version: 0,
  });
  mount(<ProfilePage />);
  expect(await screen.findByText('Ouvrir les Réglages →')).toBeTruthy();
  expect(gameApi.snapshot).not.toHaveBeenCalled();
  expect(gameApi.sync).not.toHaveBeenCalled();
});
it('uses the confirmed purchase result before offering a separate equip action', async () => {
  vi.mocked(gameApi.purchase).mockImplementation(async () => {
    vi.mocked(gameApi.snapshot).mockResolvedValue({
      ...fixture,
      version: 2,
      shards: 90,
      catalog: [{ ...fixture.catalog[0], owned: true }],
    });
    return { skin: 'eclipse', charged: 300 };
  });
  mount(<ProfilePage />, '/profile?tab=collection');
  fireEvent.click(await screen.findByRole('button', { name: /Éclipse/ }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Confirmer · 300 Éclats' })
  );
  expect(
    await screen.findByRole('button', { name: 'Équiper gratuitement' })
  ).toBeTruthy();
  expect(gameApi.purchase).toHaveBeenCalledTimes(1);
  expect(gameApi.equip).not.toHaveBeenCalled();
  expect(gameApi.sync).not.toHaveBeenCalled(); // nothing pending: reads only
  expect(screen.getByText('Solde : 90 Éclats')).toBeTruthy();
});
it('keeps the switch at the server value when saving fails', async () => {
  vi.mocked(gameApi.preference).mockResolvedValue({
    enabled: false,
    opted_in: false,
    available: true,
    version: 0,
  });
  vi.mocked(gameApi.toggle).mockRejectedValue(new Error('Réseau indisponible'));
  mount(<GamificationTab />);
  const toggle = await screen.findByRole('switch');
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain(
      'Réseau indisponible'
    )
  );
  expect(toggle.getAttribute('aria-checked')).toBe('false');
});
it('settles evidence imported elsewhere with one projection, never two', async () => {
  vi.mocked(gameApi.snapshot).mockResolvedValue({ ...structuredClone(fixture), pending: 2 });
  vi.mocked(gameApi.sync).mockResolvedValue({ ...structuredClone(fixture), pending: 1 });
  mount(<ProfilePage />);
  await waitFor(() => expect(gameApi.sync).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('Niveau 6 · Adepte')).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  // What the projection left pending waits for the next read.
  expect(gameApi.sync).toHaveBeenCalledTimes(1);
});
it('shows a failed projection over the snapshot and retries it only on a click', async () => {
  vi.mocked(gameApi.snapshot).mockResolvedValue({ ...structuredClone(fixture), pending: 2 });
  vi.mocked(gameApi.sync).mockRejectedValue(new Error('Une autre écriture est en cours.'));
  mount(<ProfilePage />);
  expect(
    await screen.findByText(/Progression non actualisée : Une autre écriture est en cours\./)
  ).toBeTruthy();
  expect(screen.getByText('Niveau 6 · Adepte')).toBeTruthy();
  expect(gameApi.sync).toHaveBeenCalledTimes(1);
  vi.mocked(gameApi.sync).mockResolvedValue({ ...structuredClone(fixture), pending: 0 });
  fireEvent.click(screen.getByRole('button', { name: 'Actualiser' }));
  await waitFor(() => expect(gameApi.sync).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText(/Progression non actualisée/)).toBeNull());
});
it('the read after a failed session-event projection does not project again', async () => {
  const client = mount(<ProfilePage />);
  expect(await screen.findByText('Niveau 6 · Adepte')).toBeTruthy();
  vi.mocked(gameApi.sync).mockRejectedValue(new Error('conflict'));
  vi.mocked(gameApi.snapshot).mockResolvedValue({ ...structuredClone(fixture), pending: 1 });
  syncGame(client);
  await waitFor(() => expect(gameApi.snapshot).toHaveBeenCalledTimes(2));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(gameApi.sync).toHaveBeenCalledTimes(1);
});
