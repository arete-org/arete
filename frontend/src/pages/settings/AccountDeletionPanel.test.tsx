// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AUTH_DISABLED, AuthStateContext, type AuthState } from '@/components/auth/authState';
import { useCoachThreads } from '@/hooks/useCoachThreads';
import { ApiError, authApi } from '@/lib/api';
import { AccountDeletionPanel } from './AccountDeletionPanel';

vi.mock('@/lib/conversations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/conversations')>()),
  conversationsApi: {
    remove: vi.fn().mockResolvedValue({ deleted: true }),
    save: vi.fn(async () => ({ revision: 1, title: 'Fil' })),
    list: vi.fn().mockResolvedValue({ items: [], next_offset: null }),
    read: vi.fn(),
  },
}));
vi.mock('@/lib/documents', () => ({ documentsApi: { deleteThread: vi.fn().mockResolvedValue({ deleted: true }) } }));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const THREADS_7 = 'arete.coach.threads.v1.athlete.7';
const THREADS_9 = 'arete.coach.threads.v1.athlete.9';

function setup(auth: Partial<AuthState> = {}, signOut = vi.fn(async () => {})) {
  const value: AuthState = { ...AUTH_DISABLED, enabled: true, athleteId: 7, signOut, ...auth };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <AuthStateContext.Provider value={value}>{children}</AuthStateContext.Provider>
    </QueryClientProvider>
  );
  render(<AccountDeletionPanel />, { wrapper });
  return { signOut, wrapper };
}

const confirmation = () => screen.getByLabelText('Tape SUPPRIMER pour confirmer');
const deleteButton = () => screen.getByRole('button', { name: /SUPPRIMER DÉFINITIVEMENT/ });
function confirmDeletion() {
  fireEvent.change(confirmation(), { target: { value: 'SUPPRIMER' } });
  fireEvent.click(deleteButton());
}

it('deletes only after the typed confirmation, then forgets this browser and signs out', async () => {
  const deleteMe = vi.spyOn(authApi, 'deleteMe').mockResolvedValue(undefined);
  localStorage.setItem(THREADS_7, '{}');
  localStorage.setItem('arete.coach.conflict.7.thread', '{}');
  localStorage.setItem('arete.coach.threads.v1.athlete.8', '{}');
  const { signOut } = setup();
  expect(screen.getByText(/deux plus récentes sont conservées/)).toBeTruthy();

  fireEvent.change(confirmation(), { target: { value: 'supprimer' } });
  expect((deleteButton() as HTMLButtonElement).disabled).toBe(true);
  confirmDeletion();

  await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
  expect(deleteMe).toHaveBeenCalledWith('SUPPRIMER');
  expect(screen.getByText(/Ton compte et tes données sont supprimés/)).toBeTruthy();
  expect(localStorage.getItem(THREADS_7)).toBeNull();
  expect(localStorage.getItem('arete.coach.conflict.7.thread')).toBeNull();
  expect(localStorage.getItem('arete.coach.threads.v1.athlete.8')).toBe('{}');
});

it('keeps the mounted coach panel from writing the erased conversations back', async () => {
  vi.spyOn(authApi, 'deleteMe').mockResolvedValue(undefined);
  // Another athlete than the other tests': this tab remembers whom it erased.
  const { signOut, wrapper } = setup({ athleteId: 9 });
  const coach = renderHook(() => useCoachThreads({ page: 'settings', path: '/settings', params: {} }), { wrapper });
  // The panel persists this athlete's threads on page exit while it lives.
  window.dispatchEvent(new Event('pagehide'));
  expect(localStorage.getItem(THREADS_9)).not.toBeNull();

  confirmDeletion();
  await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
  expect(localStorage.getItem(THREADS_9)).toBeNull();
  // The page reload unmounts the panel and fires pagehide: both used to save.
  window.dispatchEvent(new Event('pagehide'));
  coach.unmount();
  expect(localStorage.getItem(THREADS_9)).toBeNull();
});

it('shows the erasure even when signing out fails, and offers to sign out again', async () => {
  vi.spyOn(authApi, 'deleteMe').mockResolvedValue(undefined);
  const signOut = vi.fn().mockRejectedValueOnce(new Error('Clerk injoignable')).mockResolvedValue(undefined);
  setup({}, signOut);
  confirmDeletion();

  expect(await screen.findByText('La déconnexion a échoué : relance-la.')).toBeTruthy();
  expect(screen.getByText(/Ton compte et tes données sont supprimés/)).toBeTruthy();
  expect(screen.queryByText(/Suppression impossible/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'SE DÉCONNECTER' }));
  await waitFor(() => expect(signOut).toHaveBeenCalledTimes(2));
});

it('shows a refusal and keeps the session', async () => {
  const detail = 'La suppression n’a pas abouti, ton compte reste ouvert : réessaie.';
  vi.spyOn(authApi, 'deleteMe').mockRejectedValue(new ApiError(503, JSON.stringify({ detail })));
  const { signOut } = setup();
  confirmDeletion();
  expect(await screen.findByText(detail)).toBeTruthy();
  expect(signOut).not.toHaveBeenCalled();
  expect(deleteButton()).toBeTruthy();
});

it('offers to sign out when the data is gone but the login could not be deleted', async () => {
  const detail = 'Tes données sont effacées, mais ton identifiant de connexion n’a pas pu être supprimé.';
  vi.spyOn(authApi, 'deleteMe').mockRejectedValue(new ApiError(502, JSON.stringify({ detail })));
  localStorage.setItem(THREADS_7, '{}');
  const { signOut } = setup();
  confirmDeletion();
  expect(await screen.findByText(detail)).toBeTruthy();
  expect(localStorage.getItem(THREADS_7)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'SE DÉCONNECTER' }));
  await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
});

it('explains to the owner why their account stays', () => {
  setup({ athleteId: 1, isOwner: true, isAdmin: true });
  expect(screen.getByText(/Le compte propriétaire ne peut pas être supprimé/)).toBeTruthy();
  expect(screen.queryByLabelText('Tape SUPPRIMER pour confirmer')).toBeNull();
});

it('is absent without sign-in', () => {
  setup({ enabled: false });
  expect(screen.queryByText('SUPPRIMER MON COMPTE')).toBeNull();
});
