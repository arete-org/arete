import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer } from './dashboardAnswer';

/** ARE-131: the push opt-in at the two moments its value is obvious. */
const DAY = '2026-10-14';
const SESSION_OFFER = { name: 'Reçois le retour du coach après chaque séance' };
const BRIEFING_OFFER = { name: 'Reçois ton briefing chaque matin' };

const done = {
  id: 21, planned_session_id: null, date: DAY, start_time: `${DAY}T07:30:00`, sport: 'running', session_type: 'easy',
  name: 'Footing du matin', duration_sec: 2700, duration_min: '45:00', moving_time_sec: 2650, distance_m: 8200, distance_km: 8.2,
  avg_hr: 140, max_hr: 158, avg_pace_sec_km: 330, avg_pace: '5:30', ascent_m: 30, calories: 520, rpe: 5, notes: null,
  source: 'garmin', garmin_activity_id: '1', strava_activity_id: null, adherence_score: null,
};

/**
 * A browser that can receive push with a registered worker (the dev server has
 * none): the device starts unsubscribed, or subscribed when `subscribed`.
 */
async function pushDevice(page: Page, subscribed = false) {
  await page.addInitScript((already) => {
    const subscription = {
      endpoint: 'https://push.example/device',
      toJSON: () => ({ endpoint: 'https://push.example/device', keys: { p256dh: 'P256', auth: 'AUTH' } }),
      unsubscribe: async () => true,
    };
    let current = already ? subscription : null;
    const registration = {
      pushManager: {
        getSubscription: async () => current,
        subscribe: async () => { current = subscription; return subscription; },
      },
    };
    let permission: NotificationPermission = already ? 'granted' : 'default';
    Object.defineProperty(Notification, 'permission', { get: () => permission });
    Notification.requestPermission = async () => { permission = 'granted'; return permission; };
    Object.defineProperty(navigator.serviceWorker, 'getRegistration', { value: async () => registration });
  }, subscribed);
}

async function mockApi(page: Page, { actual = [] as unknown[], theme = 'pierre' } = {}) {
  const requests: string[] = [];
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    requests.push(`${request.method()} ${path}`);
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, theme, user_id: 1, display_name: 'Arthur' } });
    if (path === '/api/onboarding') return route.fulfill({ json: { status: 'completed', revision: 1 } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, opted_in: false, available: true, version: 1 } });
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'fresh' } });
    if (path === '/api/dashboard') return route.fulfill({ json: dashboardAnswer({ date: DAY, actual }) });
    if (path === '/api/analytics/sessions') return route.fulfill({ json: { sessions: actual } });
    if (path === '/api/coach/today') return route.fulfill({ json: { date: DAY, items: [], remaining: 0, briefing: null } });
    if (path === '/api/notifications/vapid-public-key') return route.fulfill({ json: { key: 'BPub' } });
    if (path === '/api/notifications/subscription') return route.fulfill({ status: 204 });
    if (path === '/api/agent/conversations') return route.fulfill({ json: { items: [], next_offset: null } });
    if (path === '/api/tips/briefings/1') {
      return route.fulfill({ json: { id: 1, date: DAY, tip: 'Prépare tes prochaines séances.', source: 'rules', generated_at: `${DAY}T07:00:00`, reaction: null, reaction_comment: null } });
    }
    return route.fulfill({ json: [] });
  });
  return requests;
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(`${DAY}T09:00:00`));
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('a session on the dashboard brings the offer once; « Plus tard » holds across a reload', async ({ page }) => {
  await pushDevice(page);
  await mockApi(page, { actual: [done] });
  await page.goto('/');
  await expect(page.getByText('Footing du matin')).toBeVisible();
  const offer = page.getByRole('region', SESSION_OFFER);
  await expect(offer).toBeVisible();
  await expect(offer).toHaveCount(1);
  // Not read yet: the briefing's own offer waits.
  await expect(page.getByRole('region', BRIEFING_OFFER)).toHaveCount(0);
  await offer.getByRole('button', { name: 'Plus tard' }).click();
  await expect(offer).toHaveCount(0);
  await expect(page.locator('body')).not.toBeFocused();
  await page.reload();
  await expect(page.getByText('Footing du matin')).toBeVisible();
  await expect(page.getByRole('region', SESSION_OFFER)).toHaveCount(0);
  // The same answer holds in the Journal.
  await page.goto('/log?tab=cardio');
  await expect(page.getByRole('heading', { name: 'Journal', level: 1 })).toBeVisible();
  await expect(page.getByText('Footing du matin')).toBeVisible();
  await expect(page.getByRole('region', SESSION_OFFER)).toHaveCount(0);
});

test('the Journal’s session list offers it too, on a device that never answered', async ({ page }) => {
  await pushDevice(page);
  await mockApi(page, { actual: [done] });
  await page.goto('/log?tab=cardio');
  await expect(page.getByText('Footing du matin')).toBeVisible();
  await expect(page.getByRole('region', SESSION_OFFER)).toHaveCount(1);
});

test('opening the briefing brings its offer; enabling subscribes this device once', async ({ page }) => {
  await pushDevice(page);
  const requests = await mockApi(page);
  await page.goto('/');
  const entry = page.getByRole('button', { name: 'En parler au coach' });
  await expect(entry).toBeEnabled();
  await expect(page.getByRole('region', BRIEFING_OFFER)).toHaveCount(0);
  // Nothing asked of the server before the moment comes.
  expect(requests).not.toContain('GET /api/notifications/vapid-public-key');
  await entry.click();
  const offer = page.getByRole('region', BRIEFING_OFFER);
  await expect(page).toHaveURL(/\/coach$/);
  await expect(offer).toHaveCount(0);
  // Back from the briefing's conversation, the offer waits under the card.
  await page.locator('#coach-panel').getByRole('button', { name: 'Retour à la page' }).click();
  await expect(offer).toBeVisible();
  await expect(offer).toHaveCount(1);
  await offer.getByRole('button', { name: 'Activer les notifications' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Notifications activées sur cet appareil.' })).toBeFocused();
  expect(requests.filter(r => r === 'POST /api/notifications/subscription')).toHaveLength(1);
  // Every kind is on by default: the settings are not rewritten.
  expect(requests).not.toContain('PUT /api/settings');
  await page.reload();
  await expect(page.getByRole('button', { name: 'En parler au coach' })).toBeEnabled();
  await expect(page.getByRole('region', BRIEFING_OFFER)).toHaveCount(0);
});

test('a device already subscribed is never offered, and asks nothing', async ({ page }) => {
  await pushDevice(page, true);
  await page.addInitScript(() => localStorage.setItem('arete.push-offer.briefing-read', '1'));
  const requests = await mockApi(page, { actual: [done] });
  await page.goto('/');
  await expect(page.getByText('Footing du matin')).toBeVisible();
  await expect(page.getByRole('button', { name: 'En parler au coach' })).toBeEnabled();
  await expect(page.getByRole('region', SESSION_OFFER)).toHaveCount(0);
  await expect(page.getByRole('region', BRIEFING_OFFER)).toHaveCount(0);
  expect(requests).not.toContain('GET /api/notifications/vapid-public-key');
});

test('without a push-capable worker, the dashboard makes no extra request', async ({ page }) => {
  const requests = await mockApi(page, { actual: [done] });
  await page.goto('/');
  await expect(page.getByText('Footing du matin')).toBeVisible();
  await expect(page.getByRole('region', SESSION_OFFER)).toHaveCount(0);
  expect(requests).not.toContain('GET /api/notifications/vapid-public-key');
});

for (const [theme, width] of [['pierre', 390], ['prune', 390], ['pierre', 1440]] as const) {
  test(`the offers fit at ${width} px — ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await pushDevice(page);
    await page.addInitScript(() => localStorage.setItem('arete.push-offer.briefing-read', '1'));
    await mockApi(page, { actual: [done], theme });
    await page.goto('/');
    const session = page.getByRole('region', SESSION_OFFER);
    const briefing = page.getByRole('region', BRIEFING_OFFER);
    await expect(session).toBeVisible();
    await expect(briefing).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `../.context/push-offer-${theme}-${width}.png`, animations: 'disabled', fullPage: width < 768 });
  });
}
