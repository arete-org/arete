// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { notificationsApi } from '@/lib/api';
import { NOTIFICATIONS_OFFERED_KEY, readFlag } from '@/lib/install';
import { EnableNotifications } from './EnableNotifications';

vi.mock('@/lib/push', () => ({
  currentState: vi.fn(async () => 'unsubscribed'),
  isStandalone: () => true,
  subscribeDevice: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.spyOn(notificationsApi, 'getVapidPublicKey').mockResolvedValue({ key: 'BPub' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mount = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <EnableNotifications />
  </QueryClientProvider>,
);

it('declining says it will not come back, and it does not', async () => {
  mount();
  // The answer is remembered for good: no « Plus tard » promising a return.
  expect(screen.queryByRole('button', { name: 'Plus tard' })).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Non merci' }));
  expect(readFlag(NOTIFICATIONS_OFFERED_KEY)).toBe('1');
  cleanup();
  mount();
  await Promise.resolve();
  expect(screen.queryByRole('button', { name: 'Activer les notifications' })).toBeNull();
});
