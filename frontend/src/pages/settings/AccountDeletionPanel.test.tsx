// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AUTH_DISABLED, AuthStateContext, type AuthState } from '@/components/auth/authState';
import { ApiError, authApi } from '@/lib/api';
import { AccountDeletionPanel } from './AccountDeletionPanel';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function mount(auth: Partial<AuthState> = {}) {
  const signOut = vi.fn(async () => {});
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AuthStateContext.Provider value={{ ...AUTH_DISABLED, enabled: true, athleteId: 7, signOut, ...auth }}>
        <AccountDeletionPanel />
      </AuthStateContext.Provider>
    </QueryClientProvider>
  );
  return signOut;
}

const confirmation = () => screen.getByLabelText('Tape SUPPRIMER pour confirmer');
const deleteButton = () => screen.getByRole('button', { name: /SUPPRIMER DÉFINITIVEMENT/ });

it('deletes only after the typed confirmation, then forgets this browser and signs out', async () => {
  const deleteMe = vi.spyOn(authApi, 'deleteMe').mockResolvedValue(undefined);
  localStorage.setItem('arete.coach.threads.v1.athlete.7', '{}');
  localStorage.setItem('arete.coach.conflict.7.thread', '{}');
  localStorage.setItem('arete.coach.threads.v1.athlete.8', '{}');
  const signOut = mount();
  expect(screen.getByText(/deux plus récentes sont conservées/)).toBeTruthy();

  fireEvent.change(confirmation(), { target: { value: 'supprimer' } });
  expect((deleteButton() as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(confirmation(), { target: { value: 'SUPPRIMER' } });
  fireEvent.click(deleteButton());

  await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
  expect(deleteMe).toHaveBeenCalledWith('SUPPRIMER');
  expect(localStorage.getItem('arete.coach.threads.v1.athlete.7')).toBeNull();
  expect(localStorage.getItem('arete.coach.conflict.7.thread')).toBeNull();
  expect(localStorage.getItem('arete.coach.threads.v1.athlete.8')).toBe('{}');
});

it('shows a refusal and keeps the session', async () => {
  const detail = 'Tu es le seul administrateur de cette instance : nomme un autre administrateur avant de supprimer ton compte.';
  vi.spyOn(authApi, 'deleteMe').mockRejectedValue(new ApiError(409, JSON.stringify({ detail })));
  const signOut = mount();
  fireEvent.change(confirmation(), { target: { value: 'SUPPRIMER' } });
  fireEvent.click(deleteButton());
  expect(await screen.findByText(detail)).toBeTruthy();
  expect(signOut).not.toHaveBeenCalled();
});

it('offers to sign out when the data is gone but the login could not be deleted', async () => {
  const detail = 'Tes données sont effacées, mais ton identifiant de connexion n’a pas pu être supprimé.';
  vi.spyOn(authApi, 'deleteMe').mockRejectedValue(new ApiError(502, JSON.stringify({ detail })));
  const signOut = mount();
  fireEvent.change(confirmation(), { target: { value: 'SUPPRIMER' } });
  fireEvent.click(deleteButton());
  expect(await screen.findByText(detail)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'SE DÉCONNECTER' }));
  await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
});

it('is absent without sign-in', () => {
  mount({ enabled: false });
  expect(screen.queryByText('SUPPRIMER MON COMPTE')).toBeNull();
});
