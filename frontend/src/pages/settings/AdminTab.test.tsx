// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AUTH_DISABLED, AuthStateContext, type AuthState } from '@/components/auth/authState';
import { adminApi, ApiError, type AdminAccount } from '@/lib/api';
import { AdminTab } from './AdminTab';

const BLANK: Omit<AdminAccount, 'athlete_id'> = {
  user_id: null,
  email: null,
  name: null,
  role: 'athlete',
  is_owner: false,
  last_seen_at: null,
  last_sync_at: null,
  sync_lease_until: null,
  lease_stuck: false,
  deactivated_at: null,
};

// Timestamps without an offset read as local time: the formatted text does not depend on the machine.
const ACCOUNTS: AdminAccount[] = [
  {
    ...BLANK,
    athlete_id: 1,
    user_id: 1,
    email: 'proprio@exemple.fr',
    name: 'Grégoire',
    is_owner: true,
    last_seen_at: '2026-10-10T08:15:00',
    last_sync_at: '2026-10-10T06:00:00',
  },
  {
    ...BLANK,
    athlete_id: 2,
    user_id: 2,
    email: 'admin@exemple.fr',
    name: 'Bea',
    role: 'admin',
    sync_lease_until: '2099-01-01T00:00:00',
  },
  {
    ...BLANK,
    athlete_id: 3,
    user_id: 3,
    email: 'ana@exemple.fr',
    name: 'Ana',
    sync_lease_until: '2026-10-09T05:00:00',
    lease_stuck: true,
  },
  { ...BLANK, athlete_id: 4, deactivated_at: '2026-10-01T09:30:00' },
];

const OWNER: AuthState = { ...AUTH_DISABLED, enabled: true, athleteId: 1, isOwner: true, isAdmin: true };
const ADMIN: AuthState = { ...AUTH_DISABLED, enabled: true, athleteId: 2, isOwner: false, isAdmin: true };

beforeEach(() => {
  vi.spyOn(adminApi, 'accounts').mockResolvedValue(ACCOUNTS);
  vi.spyOn(adminApi, 'featureFlags').mockResolvedValue({ glm_flash: false, glm_flash_available: true });
  vi.spyOn(adminApi, 'kpis').mockResolvedValue([]); // ProductKpisPanel.test.tsx
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(auth: AuthState = OWNER) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthStateContext.Provider value={auth}>
        <AdminTab />
      </AuthStateContext.Provider>
    </QueryClientProvider>
  );
}

/** The table row holding `text` (an email, or "Aucun compte"), once the list is shown. */
async function findRow(text: string) {
  return within(await screen.findByRole('row', { name: new RegExp(text) }));
}

const row = (text: string) => within(screen.getByRole('row', { name: new RegExp(text) }));

it('waits for a confirmed save before switching the paid coach on, and can revert', async () => {
  let confirm!: (value: { glm_flash: boolean; glm_flash_available: boolean }) => void;
  const save = vi.spyOn(adminApi, 'setFeatureFlags').mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  mount(ADMIN);
  const toggle = await screen.findByRole('checkbox', { name: 'Coach GLM Flash (payant)' });
  fireEvent.click(toggle);
  await waitFor(() => expect(save).toHaveBeenCalledWith(true, expect.anything()));
  expect((toggle as HTMLInputElement).checked).toBe(false);
  expect((toggle as HTMLInputElement).disabled).toBe(true);
  confirm({ glm_flash: true, glm_flash_available: true });
  await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));
  save.mockResolvedValue({ glm_flash: false, glm_flash_available: true });
  fireEvent.click(toggle);
  await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
  expect(save).toHaveBeenLastCalledWith(false, expect.anything());
});

it('keeps the saved flag and displays a failed update', async () => {
  vi.spyOn(adminApi, 'setFeatureFlags').mockRejectedValue(new ApiError(409, '{"detail":"OpenRouter indisponible."}'));
  mount();
  const toggle = await screen.findByRole('checkbox', { name: 'Coach GLM Flash (payant)' });
  fireEvent.click(toggle);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'OpenRouter indisponible.');
  expect((toggle as HTMLInputElement).checked).toBe(false);
  expect((toggle as HTMLInputElement).disabled).toBe(false);
});

it('cannot enable an unavailable model but can disable a previously enabled flag', async () => {
  vi.mocked(adminApi.featureFlags).mockResolvedValue({ glm_flash: false, glm_flash_available: false });
  const view = mount();
  expect(await screen.findByRole('checkbox', { name: 'Coach GLM Flash (payant)' })).toHaveProperty('disabled', true);
  view.unmount();
  vi.mocked(adminApi.featureFlags).mockResolvedValue({ glm_flash: true, glm_flash_available: false });
  vi.spyOn(adminApi, 'setFeatureFlags').mockResolvedValue({ glm_flash: false, glm_flash_available: false });
  mount();
  const toggle = await screen.findByRole('checkbox', { name: 'Coach GLM Flash (payant)' });
  expect(toggle).toHaveProperty('disabled', false);
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveProperty('checked', false));
});

it('does not show a false off switch when the flag cannot be read', async () => {
  vi.mocked(adminApi.featureFlags).mockRejectedValue(new TypeError('offline'));
  mount();
  expect(await screen.findByText('Options indisponibles')).toBeTruthy();
  expect(screen.queryByRole('checkbox')).toBeNull();
});

it('lists each athlete with its role, state and sync status', async () => {
  mount();
  const owner = await findRow('proprio@exemple.fr');
  expect(owner.getByText('Grégoire')).toBeTruthy();
  expect(owner.getByText('Propriétaire')).toBeTruthy();
  expect(owner.getByText('Actif')).toBeTruthy();
  expect(owner.getByText('10/10/2026 08:15')).toBeTruthy();
  expect(owner.getByText('10/10/2026 06:00')).toBeTruthy();
  expect(owner.getByText('—')).toBeTruthy();

  const admin = row('admin@exemple.fr');
  expect(admin.getByText('Admin')).toBeTruthy();
  expect(admin.getByText('En cours')).toBeTruthy();
  expect(admin.getAllByText('jamais')).toHaveLength(2);

  const ana = row('ana@exemple.fr');
  expect(ana.getByText('Athlète')).toBeTruthy();
  expect(ana.getByText('Bloquée depuis le 09/10/2026 05:00')).toBeTruthy();

  const withoutLogin = row('Aucun compte');
  expect(withoutLogin.getByText('Aucun compte (athlète 4)')).toBeTruthy();
  expect(withoutLogin.getByText('Désactivé le 01/10/2026 09:30')).toBeTruthy();
  expect(withoutLogin.getByRole('button', { name: 'Réactiver' })).toBeTruthy();
  expect(withoutLogin.queryByRole('button', { name: 'Désactiver' })).toBeNull();
});

it('deactivates and reactivates an athlete and refreshes the list', async () => {
  vi.spyOn(adminApi, 'deactivate').mockResolvedValue(undefined);
  vi.spyOn(adminApi, 'reactivate').mockResolvedValue(undefined);
  mount();
  const ana = await findRow('ana@exemple.fr');

  fireEvent.click(ana.getByRole('button', { name: 'Désactiver' }));
  fireEvent.click(ana.getByRole('button', { name: 'Annuler' }));
  fireEvent.click(ana.getByRole('button', { name: 'Désactiver' }));
  expect(adminApi.deactivate).not.toHaveBeenCalled();
  fireEvent.click(ana.getByRole('button', { name: 'Confirmer' }));

  expect((await screen.findByRole('status')).textContent).toBe('Athlète désactivé.');
  expect(adminApi.deactivate).toHaveBeenCalledWith(3, expect.anything());
  await waitFor(() => expect(adminApi.accounts).toHaveBeenCalledTimes(2));

  const reactivate = row('Aucun compte').getByRole('button', { name: 'Réactiver' });
  await waitFor(() => expect((reactivate as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(reactivate);
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Athlète réactivé.'));
  expect(adminApi.reactivate).toHaveBeenCalledWith(4, expect.anything());
  await waitFor(() => expect(adminApi.accounts).toHaveBeenCalledTimes(3));
});

it('releases a stuck lease and says when there was none', async () => {
  vi.spyOn(adminApi, 'releaseLease')
    .mockResolvedValueOnce({ released: true })
    .mockResolvedValueOnce({ released: false });
  mount();
  const ana = await findRow('ana@exemple.fr');
  expect(ana.getByText("Vérifie d'abord les effets de la dernière exécution.")).toBeTruthy();
  expect(row('proprio@exemple.fr').queryByRole('button', { name: 'Libérer la synchro' })).toBeNull();
  // A running sync holds its lease: releasing it would start a second run.
  expect(row('admin@exemple.fr').queryByRole('button', { name: 'Libérer la synchro' })).toBeNull();

  const release = ana.getByRole('button', { name: 'Libérer la synchro' });
  fireEvent.click(release);
  expect((await screen.findByRole('status')).textContent).toBe(
    'Synchro libérée : elle sera relancée à la prochaine exécution.'
  );
  expect(adminApi.releaseLease).toHaveBeenCalledWith(3, expect.anything());

  await waitFor(() => expect((release as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(release);
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Aucune synchro à libérer.'));
});

it('offers role changes to the owner only, never on the owner row', async () => {
  vi.spyOn(adminApi, 'setRole').mockResolvedValue({
    email: 'ana@exemple.fr',
    name: 'Ana',
    athlete_id: 3,
    is_owner: false,
    role: 'admin',
    is_admin: true,
  });
  const view = mount();
  const ana = await findRow('ana@exemple.fr');
  expect(row('proprio@exemple.fr').queryByRole('button', { name: /admin/ })).toBeNull();
  expect(row('Aucun compte').queryByRole('button', { name: /admin/ })).toBeNull();
  expect(row('admin@exemple.fr').getByRole('button', { name: 'Retirer admin' })).toBeTruthy();

  fireEvent.click(ana.getByRole('button', { name: 'Nommer admin' }));
  expect((await screen.findByRole('status')).textContent).toBe('Rôle mis à jour.');
  expect(adminApi.setRole).toHaveBeenCalledWith(3, 'admin');
  view.unmount();

  mount(ADMIN);
  await findRow('ana@exemple.fr');
  expect(screen.queryByRole('button', { name: /admin/ })).toBeNull();
});

it('hides deactivation of an admin from a non-owner admin', async () => {
  const view = mount(ADMIN);
  expect((await findRow('ana@exemple.fr')).getByRole('button', { name: 'Désactiver' })).toBeTruthy();
  expect(row('admin@exemple.fr').queryByRole('button', { name: 'Désactiver' })).toBeNull();
  expect(row('proprio@exemple.fr').queryByRole('button', { name: 'Désactiver' })).toBeNull();
  view.unmount();

  mount(OWNER);
  expect((await findRow('admin@exemple.fr')).getByRole('button', { name: 'Désactiver' })).toBeTruthy();
  expect(row('proprio@exemple.fr').queryByRole('button', { name: 'Désactiver' })).toBeNull();
});

it('shows the server reason when an action is refused', async () => {
  vi.spyOn(adminApi, 'deactivate').mockRejectedValue(
    new ApiError(403, '{"detail":"Seul le propriétaire peut désactiver un administrateur."}')
  );
  vi.spyOn(adminApi, 'reactivate').mockRejectedValue(new TypeError('Failed to fetch'));
  mount();
  const ana = await findRow('ana@exemple.fr');
  fireEvent.click(ana.getByRole('button', { name: 'Désactiver' }));
  fireEvent.click(ana.getByRole('button', { name: 'Confirmer' }));

  expect((await screen.findByRole('alert')).textContent).toBe(
    'Seul le propriétaire peut désactiver un administrateur.'
  );
  expect(screen.queryByRole('status')).toBeNull();
  expect(ana.getByRole('button', { name: 'Désactiver' })).toBeTruthy();

  // Without a reason from the server, a generic one.
  const reactivate = row('Aucun compte').getByRole('button', { name: 'Réactiver' });
  await waitFor(() => expect((reactivate as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(reactivate);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Action impossible.'));
});
