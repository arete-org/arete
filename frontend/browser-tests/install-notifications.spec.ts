import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

async function mockApi(page: Page, saved: unknown[] = []) {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/settings') {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON();
        saved.push(body);
        return route.fulfill({ json: { ...body, user_id: 1 } });
      }
      return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1 } });
    }
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, opted_in: false, available: true, version: 1 } });
    if (path === '/api/notifications/vapid-public-key') return route.fulfill({ json: { key: 'BPub' } });
    if (path === '/api/agent/memory') return route.fulfill({ json: { files: [] } });
    if (path === '/api/sync/status' || path === '/api/garmin/sync/status') return route.fulfill({ json: { garmin_authenticated: true } });
    return route.fulfill({ json: [] });
  });
}

/** A returning athlete: the app was already opened on an earlier day. */
async function returning(page: Page, standalone: boolean) {
  await page.addInitScript((installed) => {
    localStorage.setItem('arete.install.days', '2026-01-01');
    if (installed) Object.defineProperty(navigator, 'standalone', { value: true });
  }, standalone);
}

test.describe('iPhone', () => {
  test.use({ userAgent: IPHONE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('Safari shows the home-screen guide until dismissed', async ({ page }) => {
    await mockApi(page);
    await returning(page, false);
    await page.goto('/settings?tab=coach');
    const banner = page.getByRole('region', { name: 'Installer Arete' });
    await expect(banner).toBeVisible();
    await expect(banner.getByText('Choisis « Sur l’écran d’accueil », puis « Ajouter ».')).toBeVisible();
    // The coach tab explains the same steps where notifications are enabled.
    await expect(page.getByRole('list', { name: 'Installer Arete sur iPhone' })).toHaveCount(2);
    await page.screenshot({ path: '../.context/install-ios-guide.png', fullPage: true, animations: 'disabled' });
    await banner.getByRole('button', { name: 'Ne plus proposer' }).click();
    await expect(banner).toBeHidden();
    await page.reload();
    await expect(page.getByRole('region', { name: 'Installer Arete' })).toBeHidden();
  });

  test('the installed app hides the guide', async ({ page }) => {
    await mockApi(page);
    await returning(page, true);
    await page.goto('/settings?tab=coach');
    await expect(page.getByText('Recevoir les notifications du coach.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Installer Arete' })).toBeHidden();
    await expect(page.getByRole('list', { name: 'Installer Arete sur iPhone' })).toHaveCount(0);
  });

  test('a first visit does not interrupt with the guide', async ({ page }) => {
    await mockApi(page);
    await page.goto('/settings?tab=coach');
    await expect(page.getByText('Recevoir les notifications du coach.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Installer Arete' })).toBeHidden();
  });
});

test('notification kinds and quiet hours are saved with the settings', async ({ page }) => {
  const saved: { notification_preferences: { kinds: Record<string, boolean>; quiet_hours: unknown } }[] = [];
  await mockApi(page, saved);
  await page.goto('/settings?tab=coach');
  await page.getByRole('checkbox', { name: 'Séances importées' }).uncheck();
  // The check-in push ships (ARE-59); the evening message is still to come.
  await expect(page.getByRole('checkbox', { name: /Check-in du matin/ })).toBeEnabled();
  await expect(page.getByRole('checkbox', { name: /Message du soir/ })).toBeDisabled();
  await page.getByLabel('Début des heures calmes').fill('22:00');
  await page.getByRole('button', { name: 'ENREGISTRER' }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0].notification_preferences.kinds.imports).toBe(false);
  expect(saved[0].notification_preferences.kinds.briefing).toBe(true);
  expect(saved[0].notification_preferences.quiet_hours).toEqual({ start: '22:00', end: '07:00' });
});
