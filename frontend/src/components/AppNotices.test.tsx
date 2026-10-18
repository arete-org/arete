// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { reportRequest } from '@/lib/connectivity';
import { AppNotices } from './AppNotices';

afterEach(() => { cleanup(); act(() => reportRequest(true)); vi.restoreAllMocks(); });

function mount() {
  const client = new QueryClient();
  const refetch = vi.spyOn(client, 'refetchQueries').mockResolvedValue();
  render(<QueryClientProvider client={client}><button type="button">Avant</button><AppNotices /></QueryClientProvider>);
  return refetch;
}

function setOnline(online: boolean) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
  act(() => { window.dispatchEvent(new Event(online ? 'online' : 'offline')); });
}

it('says the server is out of reach, retries on demand and goes once a request gets through', () => {
  const refetch = mount();
  expect(screen.queryByRole('status', { name: 'Connexion' })).toBeNull();
  act(() => reportRequest(false));
  expect(screen.getByRole('status', { name: 'Connexion' }).textContent).toContain('Serveur injoignable');
  fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
  expect(refetch).toHaveBeenCalledWith({ type: 'active' });
  act(() => reportRequest(true));
  expect(screen.queryByRole('status', { name: 'Connexion' })).toBeNull();
});

it('holds a dismissal for the current outage only, and keeps the focus out of the page body', () => {
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  mount();
  setOnline(false);
  expect(screen.getByRole('status', { name: 'Connexion' }).textContent).toContain('Hors connexion');
  const dismiss = screen.getByRole('button', { name: 'Masquer l’alerte de connexion' });
  dismiss.focus();
  fireEvent.click(dismiss);
  expect(screen.queryByRole('status', { name: 'Connexion' })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Avant' }));
  setOnline(true);
  setOnline(false);
  expect(screen.getByRole('status', { name: 'Connexion' })).toBeTruthy();
});
