// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AUTH_DISABLED, AuthStateContext, type AuthState } from '@/components/auth/authState';
import { SettingsProvider } from '@/contexts/SettingsContext';
import { adminApi, settingsApi } from '@/lib/api';
import { initializeTheme } from '@/lib/theme';
import { SettingsPage } from './Settings';
import { DEFAULT_SETTINGS } from './settings/types';

let client: QueryClient;
const saved = { ...DEFAULT_SETTINGS, user_id: 1 };

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = '<meta name="theme-color" content="#0A0A0F">';
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['settings'], saved);
  vi.spyOn(settingsApi, 'get').mockResolvedValue(saved);
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

function mount(path: string, auth: AuthState = AUTH_DISABLED) {
  return render(
    <QueryClientProvider client={client}>
      <AuthStateContext.Provider value={auth}>
        <MemoryRouter initialEntries={[path]}>
          <SettingsProvider><SettingsPage /></SettingsProvider>
        </MemoryRouter>
      </AuthStateContext.Provider>
    </QueryClientProvider>,
  );
}

function openAppearance(path = '/settings') {
  const view = mount(path);
  if (path === '/settings') {
    fireEvent.click(screen.getByRole('button', { name: 'APPARENCE' }));
  }
  fireEvent.click(screen.getByRole('button', { name: 'CLAIR' }));
  return view;
}

it('previews light immediately and restores the saved theme on exit', () => {
  const view = openAppearance();
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(screen.getByRole('button', { name: 'CLAIR' }).getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#F4F7FA');
  view.unmount();
  expect(document.documentElement.dataset.theme).toBe('dark');
  initializeTheme();
  expect(document.documentElement.dataset.theme).toBe('dark');
});

it('opens the appearance deep link and keeps the preview while switching tabs', () => {
  const view = openAppearance('/settings?tab=appearance');
  fireEvent.click(screen.getByRole('button', { name: 'PROFIL' }));
  expect(document.documentElement.dataset.theme).toBe('light');
  fireEvent.click(screen.getByRole('button', { name: 'APPARENCE' }));
  expect(screen.getByRole('button', { name: 'CLAIR' }).getAttribute('aria-pressed')).toBe('true');
  view.unmount();
  expect(document.documentElement.dataset.theme).toBe('dark');
});

it('keeps a successfully saved light theme after exit and reload', async () => {
  const light = { ...saved, theme: 'light' as const };
  vi.spyOn(settingsApi, 'update').mockResolvedValue(light);
  vi.mocked(settingsApi.get).mockResolvedValue(light);
  const view = openAppearance();
  fireEvent.click(screen.getByRole('button', { name: 'ENREGISTRER' }));
  await waitFor(() => expect(client.getQueryData(['settings'])).toEqual(light));
  view.unmount();
  initializeTheme();
  expect(document.documentElement.dataset.theme).toBe('light');
});

it('does not persist a preview when saving fails', async () => {
  vi.spyOn(settingsApi, 'update').mockRejectedValue(new Error('Offline'));
  const view = openAppearance();
  fireEvent.click(screen.getByRole('button', { name: 'ENREGISTRER' }));
  await screen.findByText('ÉCHEC');
  expect(document.documentElement.dataset.theme).toBe('light');
  view.unmount();
  initializeTheme();
  expect(document.documentElement.dataset.theme).toBe('dark');
});

const SIGNED_IN: AuthState = { ...AUTH_DISABLED, enabled: true, email: 'ana@exemple.fr' };

it('shows the administration tab to admins only', async () => {
  vi.spyOn(adminApi, 'accounts').mockResolvedValue([]);
  vi.spyOn(adminApi, 'featureFlags').mockResolvedValue({ glm_flash: false, glm_flash_available: true });
  const view = mount('/settings');
  expect(screen.queryByRole('button', { name: 'ADMINISTRATION' })).toBeNull();
  view.unmount();
  const signedIn = mount('/settings', SIGNED_IN);
  expect(screen.queryByRole('button', { name: 'ADMINISTRATION' })).toBeNull();
  signedIn.unmount();

  mount('/settings', { ...SIGNED_IN, isAdmin: true });
  fireEvent.click(screen.getByRole('button', { name: 'ADMINISTRATION' }));
  expect(await screen.findByRole('heading', { name: 'COMPTES ET ATHLÈTES' })).toBeTruthy();
  expect(adminApi.accounts).toHaveBeenCalled();
});

it('falls back to the profile tab on an admin deep link for a non-admin', () => {
  const accounts = vi.spyOn(adminApi, 'accounts').mockResolvedValue([]);
  mount('/settings?tab=admin', SIGNED_IN);
  expect(screen.getByRole('heading', { name: 'PROFIL' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'COMPTES ET ATHLÈTES' })).toBeNull();
  expect(accounts).not.toHaveBeenCalled();
});

it.each(['pierre', 'prune'] as const)('saves %s through the settings API and restores it on reload', async theme => {
  const updated = { ...saved, theme };
  vi.spyOn(settingsApi, 'update').mockResolvedValue(updated);
  vi.mocked(settingsApi.get).mockResolvedValue(updated);
  const view = openAppearance();
  fireEvent.click(screen.getByRole('button', { name: theme.toUpperCase() }));
  expect(document.documentElement.dataset.theme).toBe(theme);
  fireEvent.click(screen.getByRole('button', { name: 'ENREGISTRER' }));
  await waitFor(() => expect(client.getQueryData(['settings'])).toEqual(updated));
  expect(vi.mocked(settingsApi.update).mock.calls[0][0]).toEqual(expect.objectContaining({ theme }));
  view.unmount();
  initializeTheme();
  expect(document.documentElement.dataset.theme).toBe(theme);
});
