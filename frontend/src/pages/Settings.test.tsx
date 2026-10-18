// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AUTH_DISABLED, AuthStateContext, type AuthState } from '@/components/auth/authState';
import { SettingsProvider } from '@/contexts/SettingsContext';
import { adminApi, authApi, settingsApi } from '@/lib/api';
import { qk } from '@/lib/queryKeys';
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

/** Tabs load on first view: wait for the appearance tab before choosing a theme. */
async function openAppearance(path = '/settings') {
  const view = mount(path);
  if (path === '/settings') {
    fireEvent.click(screen.getByRole('button', { name: 'APPARENCE' }));
  }
  fireEvent.click(await screen.findByRole('button', { name: 'CLAIR' }));
  return view;
}

it('previews light immediately and restores the saved theme on exit', async () => {
  const view = await openAppearance();
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(screen.getByRole('button', { name: 'CLAIR' }).getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#F4F7FA');
  view.unmount();
  expect(document.documentElement.dataset.theme).toBe('dark');
  initializeTheme();
  expect(document.documentElement.dataset.theme).toBe('dark');
});

it('opens the appearance deep link and keeps the preview while switching tabs', async () => {
  const view = await openAppearance('/settings?tab=appearance');
  fireEvent.click(screen.getByRole('button', { name: 'PROFIL' }));
  expect(document.documentElement.dataset.theme).toBe('light');
  fireEvent.click(screen.getByRole('button', { name: 'APPARENCE' }));
  expect((await screen.findByRole('button', { name: 'CLAIR' })).getAttribute('aria-pressed')).toBe('true');
  view.unmount();
  expect(document.documentElement.dataset.theme).toBe('dark');
});

it('keeps a successfully saved light theme after exit and reload', async () => {
  const light = { ...saved, theme: 'light' as const };
  vi.spyOn(settingsApi, 'update').mockResolvedValue(light);
  vi.mocked(settingsApi.get).mockResolvedValue(light);
  const view = await openAppearance();
  fireEvent.click(screen.getByRole('button', { name: 'ENREGISTRER' }));
  await waitFor(() => expect(client.getQueryData(['settings'])).toEqual(light));
  view.unmount();
  initializeTheme();
  expect(document.documentElement.dataset.theme).toBe('light');
});

it('does not persist a preview when saving fails', async () => {
  vi.spyOn(settingsApi, 'update').mockRejectedValue(new Error('Offline'));
  const view = await openAppearance();
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

it('falls back to the profile tab on an admin deep link for a non-admin', async () => {
  const accounts = vi.spyOn(adminApi, 'accounts').mockResolvedValue([]);
  mount('/settings?tab=admin', SIGNED_IN);
  expect(await screen.findByRole('heading', { name: 'PROFIL' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'COMPTES ET ATHLÈTES' })).toBeNull();
  expect(accounts).not.toHaveBeenCalled();
});

it('saves coordinated follow-up without requiring push notifications', async () => {
  const withoutPush = { ...saved, notifications_enabled: false };
  const updated = { ...withoutPush, notification_preferences: { ...saved.notification_preferences, coordinated_coaching: true } };
  client.setQueryData(qk.settings, withoutPush);
  client.setQueryData(qk.athleteFacts, []);
  client.setQueryData(qk.syncStatus, { garmin_authenticated: false });
  client.setQueryData(qk.pushState, 'unsupported');
  client.setQueryData(qk.vapidKey, { key: null });
  client.setQueryData(['agentMemory'], { files: [] });
  vi.spyOn(settingsApi, 'update').mockResolvedValue(updated);
  mount('/settings?tab=coach');
  const checkbox = await screen.findByRole('checkbox', { name: /Coordonner les suivis de Chiron/ });
  expect((checkbox as HTMLInputElement).disabled).toBe(false);
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole('button', { name: 'ENREGISTRER' }));
  await waitFor(() => expect(vi.mocked(settingsApi.update).mock.calls[0]?.[0]).toEqual(expect.objectContaining({
    notifications_enabled: false,
    notification_preferences: expect.objectContaining({ coordinated_coaching: true }),
  })));
});

it.each(['pierre', 'prune'] as const)('saves %s through the settings API and restores it on reload', async theme => {
  const updated = { ...saved, theme };
  vi.spyOn(settingsApi, 'update').mockResolvedValue(updated);
  vi.mocked(settingsApi.get).mockResolvedValue(updated);
  const view = await openAppearance();
  fireEvent.click(screen.getByRole('button', { name: theme.toUpperCase() }));
  expect(document.documentElement.dataset.theme).toBe(theme);
  fireEvent.click(screen.getByRole('button', { name: 'ENREGISTRER' }));
  await waitFor(() => expect(client.getQueryData(['settings'])).toEqual(updated));
  expect(vi.mocked(settingsApi.update).mock.calls[0][0]).toEqual(expect.objectContaining({ theme }));
  view.unmount();
  initializeTheme();
  expect(document.documentElement.dataset.theme).toBe(theme);
});

it('keeps an unsaved edit when another tab saves, and adopts the fields left alone', async () => {
  const update = vi.spyOn(settingsApi, 'update').mockImplementation(async (body) => ({ ...body, user_id: 1 }));
  mount('/settings');
  const name = await screen.findByDisplayValue(saved.display_name);
  fireEvent.change(name, { target: { value: 'Nouveau nom' } });
  // Another tab saved the notifications (PushOffer) and broadcast a refresh.
  vi.mocked(settingsApi.get).mockResolvedValue({ ...saved, notifications_enabled: false });
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['settings'] });
    await new Promise((resolve) => setTimeout(resolve, 0)); // React Query notifies on the next tick
  });
  expect((screen.getByDisplayValue('Nouveau nom') as HTMLInputElement).value).toBe('Nouveau nom');
  fireEvent.click(screen.getByRole('button', { name: /ENREGISTRER/ }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update.mock.calls[0][0].display_name).toBe('Nouveau nom');
  expect(update.mock.calls[0][0].notifications_enabled).toBe(false);
});

it('keeps quiet hours edited here and a kind another tab turned on, both in the save', async () => {
  const prefs = DEFAULT_SETTINGS.notification_preferences;
  const before = { ...saved, notifications_enabled: false, notification_preferences: { ...prefs, kinds: { ...prefs.kinds, post_session: false } } };
  client.setQueryData(['settings'], before);
  vi.mocked(settingsApi.get).mockResolvedValue(before);
  const update = vi.spyOn(settingsApi, 'update').mockImplementation(async (body) => ({ ...body, user_id: 1 }));
  mount('/settings?tab=coach');
  fireEvent.change(await screen.findByLabelText('Début des heures calmes'), { target: { value: '22:15' } });
  // Another tab accepted the post-session offer: master switch and kind on, broadcast.
  vi.mocked(settingsApi.get).mockResolvedValue({ ...before, notifications_enabled: true, notification_preferences: { ...prefs, kinds: { ...prefs.kinds, post_session: true } } });
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['settings'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  fireEvent.click(screen.getByRole('button', { name: /ENREGISTRER/ }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  const body = update.mock.calls[0][0];
  expect(body.notification_preferences.quiet_hours?.start).toBe('22:15');
  expect(body.notification_preferences.kinds.post_session).toBe(true);
  expect(body.notifications_enabled).toBe(true);
});

const CONSENTED = {
  required: true,
  current: true,
  terms_version: '2026-10-draft-1',
  privacy_version: '2026-10-draft-1',
  latest: {
    terms_version: '2026-10-draft-1',
    privacy_version: '2026-10-draft-1',
    health_data: true,
    consented_at: '2026-10-18T08:30:00Z',
    withdrawn_at: null,
  },
};

it('shows the texts and the current consent in À propos, and withdraws it after a confirmation', async () => {
  const withdrawn = {
    ...CONSENTED,
    current: false,
    latest: { ...CONSENTED.latest, withdrawn_at: '2026-10-18T09:00:00Z' },
  };
  const withdraw = vi.spyOn(authApi, 'withdrawConsent').mockResolvedValue(withdrawn);
  const setConsent = vi.fn();
  mount('/settings?tab=about', { ...SIGNED_IN, consent: CONSENTED, setConsent });

  expect(await screen.findByRole('heading', { name: 'À PROPOS' })).toBeTruthy();
  const accepted = screen.getByText(/Conditions d’utilisation et politique de confidentialité acceptées le/);
  expect(accepted.textContent).toContain('18 octobre 2026');
  expect(accepted.textContent).toContain('2026-10-draft-1');
  expect(screen.getByText(/Consentement explicite au traitement de tes données de santé donné le/)).toBeTruthy();

  // Both texts open in place, rendered from the repository's Markdown.
  fireEvent.click(screen.getByRole('button', { name: "Lire : Conditions d'utilisation" }));
  const terms = await screen.findByRole('region', { name: "Conditions d'utilisation" });
  expect(await within(terms).findByRole('heading', { name: "Conditions d'utilisation d'Arete" })).toBeTruthy();
  expect(within(terms).getByText(/BROUILLON — à valider/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Lire : Politique de confidentialité' }));
  const privacy = await screen.findByRole('region', { name: 'Politique de confidentialité' });
  expect(await within(privacy).findByText(/\[NOM DU RESPONSABLE DU TRAITEMENT\], personne physique/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /RETIRER MON CONSENTEMENT/ }));
  expect(withdraw).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'CONFIRMER LE RETRAIT' }));
  await waitFor(() => expect(setConsent).toHaveBeenCalledWith(withdrawn));
  expect(withdraw).toHaveBeenCalledTimes(1);
});

it('says no consent is asked on an instance without sign-in', async () => {
  mount('/settings?tab=about');
  expect(await screen.findByText(/aucun consentement n’y est demandé/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /RETIRER MON CONSENTEMENT/ })).toBeNull();
});
