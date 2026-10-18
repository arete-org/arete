// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { notificationsApi, settingsApi, type UserSettings } from '@/lib/api';
import { pushOfferKey } from '@/lib/install';
import { currentState, subscribeDevice, type PushState } from '@/lib/push';
import { qk } from '@/lib/queryKeys';
import { DEFAULT_SETTINGS } from '@/pages/settings/types';
import { PushOffer } from './PushOffer';

vi.mock('@/lib/push', () => ({ currentState: vi.fn(), subscribeDevice: vi.fn() }));

const SESSION = 'Reçois le retour du coach après chaque séance';
let vapid: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  vapid = vi.spyOn(notificationsApi, 'getVapidPublicKey').mockResolvedValue({ key: 'BPub' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(currentState).mockReset(); vi.mocked(subscribeDevice).mockReset(); });

function mount(state: PushState, settings: UserSettings | null = { ...DEFAULT_SETTINGS, user_id: 1 } as UserSettings) {
  vi.mocked(currentState).mockResolvedValue(state);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (settings) client.setQueryData(qk.settings, settings);
  const view = render(
    <QueryClientProvider client={client}>
      <button type="button">Avant</button>
      <PushOffer moment="session" />
    </QueryClientProvider>,
  );
  return { client, ...view };
}

it.each(['subscribed', 'no-worker', 'denied', 'unsupported'] as PushState[])('stays hidden and asks nothing when the device is %s', async (state) => {
  mount(state);
  await waitFor(() => expect(currentState).toHaveBeenCalled());
  expect(screen.queryByRole('region', { name: SESSION })).toBeNull();
  expect(vapid).not.toHaveBeenCalled();
});

it('enables push from the click, remembers it and confirms in place with the focus', async () => {
  vi.mocked(subscribeDevice).mockResolvedValue('subscribed');
  const update = vi.spyOn(settingsApi, 'update');
  const { client } = mount('unsubscribed');
  const offer = await screen.findByRole('region', { name: SESSION });
  fireEvent.click(screen.getByRole('button', { name: 'Activer les notifications' }));
  const status = await screen.findByRole('status');
  expect(subscribeDevice).toHaveBeenCalledWith('BPub');
  expect(offer.isConnected).toBe(false);
  expect(document.activeElement).toBe(status);
  expect(localStorage.getItem(pushOfferKey('session'))).toBe('enabled');
  expect(client.getQueryData(qk.pushState)).toBe('subscribed');
  // Every kind is already on: nothing to save.
  expect(update).not.toHaveBeenCalled();
});

it('turns the moment’s kind and the master switch back on when the athlete had them off', async () => {
  vi.mocked(subscribeDevice).mockResolvedValue('subscribed');
  const off = {
    ...DEFAULT_SETTINGS, user_id: 1, notifications_enabled: false,
    notification_preferences: { ...DEFAULT_SETTINGS.notification_preferences, kinds: { ...DEFAULT_SETTINGS.notification_preferences.kinds, post_session: false, briefing: false } },
  } as UserSettings;
  const update = vi.spyOn(settingsApi, 'update').mockImplementation(async (body) => ({ ...body, user_id: 1 }));
  mount('unsubscribed', off);
  fireEvent.click(await screen.findByRole('button', { name: 'Activer les notifications' }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  const body = update.mock.calls[0][0];
  expect(body.notifications_enabled).toBe(true);
  expect(body.notification_preferences.kinds.post_session).toBe(true);
  // Only this moment's ritual: the briefing stays off.
  expect(body.notification_preferences.kinds.briefing).toBe(false);
  expect('user_id' in body).toBe(false);
});

it('remembers « Plus tard », gives the focus back before it and never shows again', async () => {
  // jsdom lays nothing out: every control counts as visible.
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  const first = mount('unsubscribed');
  await screen.findByRole('region', { name: SESSION });
  screen.getByRole('button', { name: 'Plus tard' }).focus();
  fireEvent.click(screen.getByRole('button', { name: 'Plus tard' }));
  expect(screen.queryByRole('region', { name: SESSION })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Avant' }));
  expect(localStorage.getItem(pushOfferKey('session'))).toBe('dismissed');
  first.unmount();
  vi.mocked(currentState).mockClear();
  mount('unsubscribed');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Avant' })).toBeTruthy());
  expect(screen.queryByRole('region', { name: SESSION })).toBeNull();
  expect(currentState).not.toHaveBeenCalled();
});

it('takes a refused permission as an answer', async () => {
  vi.mocked(subscribeDevice).mockResolvedValue('denied');
  mount('unsubscribed');
  fireEvent.click(await screen.findByRole('button', { name: 'Activer les notifications' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: SESSION })).toBeNull());
  expect(localStorage.getItem(pushOfferKey('session'))).toBe('declined');
});

it('keeps the offer with a French message when activation fails', async () => {
  vi.mocked(subscribeDevice).mockRejectedValue(new Error('Abonnement push incomplet'));
  mount('unsubscribed');
  fireEvent.click(await screen.findByRole('button', { name: 'Activer les notifications' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Activation impossible : réessaie depuis Réglages → Coach.');
  expect(screen.getByRole('region', { name: SESSION })).toBeTruthy();
  expect(localStorage.getItem(pushOfferKey('session'))).toBeNull();
});

it('leads to the home-screen guide first on iOS outside the installed app', async () => {
  mount('ios-not-installed');
  await screen.findByRole('region', { name: SESSION });
  expect(screen.queryByRole('button', { name: 'Activer les notifications' })).toBeNull();
  const install = screen.getByRole('button', { name: 'Installer l’app d’abord' });
  expect(install.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(install);
  expect(screen.getByRole('list', { name: 'Installer Arete sur iPhone' })).toBeTruthy();
  expect(install.getAttribute('aria-expanded')).toBe('true');
  expect(vapid).not.toHaveBeenCalled();
});

it('still offers when storage is blocked', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  mount('unsubscribed');
  await screen.findByRole('region', { name: SESSION });
  fireEvent.click(screen.getByRole('button', { name: 'Plus tard' }));
  expect(screen.queryByRole('region', { name: SESSION })).toBeNull();
});
