import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer } from './dashboardAnswer';

/** ARE-133: 404, connectivity, new version, accessible names. */
const DAY = '2026-10-14';
const planned = {
  id: 7, date: DAY, sport: 'running', session_type: 'easy', source: 'coach', description: 'Footing du jour', status: 'pending',
  revision: 1, target_duration_min: 40, target_distance_km: null, target_hr_zone: 2, target_intensity: null, garmin_workout_id: null, garmin_pushed_at: null,
};
const health = {
  date: DAY, readiness_score: 48, training_readiness_score: 52, hrv_last_night: 41, hrv_status: 'LOW', sleep_score: 70,
  sleep_duration_sec: 25200, stress_avg: 44, steps: 8000,
};

async function mockApi(page: Page, theme = 'pierre') {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, theme, user_id: 1, display_name: 'Arthur' } });
    if (path === '/api/onboarding') return route.fulfill({ json: { status: 'completed', revision: 1 } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, opted_in: false, available: true, version: 1 } });
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'fresh' } });
    if (path === '/api/dashboard') return route.fulfill({ json: dashboardAnswer({ date: DAY, planned: [planned], health, garmin_connected: true }) });
    if (path === '/api/coach/today') return route.fulfill({ json: { date: DAY, items: [], remaining: 0, briefing: null } });
    if (path === '/api/garmin/planned') return route.fulfill({ json: [planned] });
    return route.fulfill({ json: [] });
  });
}

/** Buttons a screen reader would announce without a name (a `title` alone does not count here). */
async function unnamedButtons(page: Page): Promise<string[]> {
  return page.locator('button:visible, [role="button"]:visible').evaluateAll((buttons) =>
    buttons
      .filter((button) => {
        const labelledby = button.getAttribute('aria-labelledby');
        const named = button.getAttribute('aria-label')?.trim()
          || (labelledby && labelledby.split(' ').some((id) => document.getElementById(id)?.textContent?.trim()))
          || button.textContent?.trim();
        return !named;
      })
      .map((button) => button.outerHTML.slice(0, 160)),
  );
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(`${DAY}T09:00:00`));
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('an unknown address shows the French 404 with a way home', async ({ page }) => {
  await mockApi(page);
  await page.goto('/nope');
  await expect(page.getByRole('heading', { name: 'Page introuvable', level: 1 })).toBeVisible();
  await expect(page.getByText('/nope')).toBeVisible();
  await page.getByRole('link', { name: 'Retour à l’accueil' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: /Bonjour/ })).toBeVisible();
});

test('losing the network shows a dismissible banner, which goes once back online', async ({ page, context }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Bonjour/ })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const banner = page.getByRole('status', { name: 'Connexion' });
  await expect(banner).toHaveCount(0);
  await context.setOffline(true);
  await expect(banner).toContainText('Hors connexion');
  await banner.getByRole('button', { name: 'Masquer l’alerte de connexion' }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.locator('body')).not.toBeFocused();
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
  await context.setOffline(true);
  // A new outage shows again.
  await expect(banner).toBeVisible();
  await context.setOffline(false);
  await expect(banner).toHaveCount(0);
});

test('a request that never reaches the server says so until one does', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Bonjour/ })).toBeVisible();
  await page.route('**/api/garmin/planned**', (route) => route.abort('internetdisconnected'));
  await page.getByRole('link', { name: 'Planning' }).first().click();
  const banner = page.getByRole('status', { name: 'Connexion' });
  await expect(banner).toContainText('Serveur injoignable');
  await page.unroute('**/api/garmin/planned**');
  await banner.getByRole('button', { name: 'Réessayer' }).click();
  await expect(banner).toHaveCount(0);
});

/**
 * A service worker for the dev server (which has none): a page already
 * controlled, and a new version either waiting as the page loads (`atLoad`) or
 * finishing its install a moment after. Posting SKIP_WAITING hands over.
 */
async function newVersion(page: Page, atLoad: boolean) {
  await page.addInitScript((waitingAtLoad) => {
    const loads = Number(sessionStorage.getItem('loads') ?? 0) + 1;
    sessionStorage.setItem('loads', String(loads));
    const listeners: Record<string, () => void> = {};
    const worker = {
      state: 'installed',
      postMessage: (message: { type?: string }) => {
        sessionStorage.setItem('posted', String(message.type));
        navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));
      },
      addEventListener() {}, removeEventListener() {},
    };
    const registration = {
      waiting: waitingAtLoad ? worker : null,
      installing: null as unknown,
      addEventListener: (type: string, listener: () => void) => { listeners[type] = listener; },
      removeEventListener() {},
      update: async () => {},
    };
    if (!waitingAtLoad) {
      setTimeout(() => { registration.installing = worker; listeners.updatefound?.(); }, 300);
    }
    Object.defineProperty(navigator.serviceWorker, 'ready', { value: Promise.resolve(registration) });
    Object.defineProperty(navigator.serviceWorker, 'controller', { value: {} });
  }, atLoad);
}

test('a version installed while the page is open is announced and « Recharger » hands over to it', async ({ page }) => {
  await newVersion(page, false);
  await mockApi(page);
  await page.goto('/');
  const notice = page.getByRole('status', { name: 'Mise à jour' });
  await expect(notice).toContainText('Nouvelle version disponible.');
  expect(await page.evaluate(() => sessionStorage.getItem('posted'))).toBeNull();
  const reloaded = page.waitForEvent('load');
  await notice.getByRole('button', { name: 'Recharger' }).click();
  await reloaded;
  expect(await page.evaluate(() => sessionStorage.getItem('posted'))).toBe('SKIP_WAITING');
});

test('a page that loads while a version waits takes it at once, and never loops', async ({ page }) => {
  await newVersion(page, true);
  await mockApi(page);
  await page.goto('/');
  // The first load handed over and reloaded; the reloaded page, finding a version
  // still waiting within the loop guard, announces it instead of reloading again.
  const notice = page.getByRole('status', { name: 'Mise à jour' });
  await expect(notice).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('posted'))).toBe('SKIP_WAITING');
  expect(await page.evaluate(() => sessionStorage.getItem('loads'))).toBe('2');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => sessionStorage.getItem('loads'))).toBe('2');
});

test('a first install, with no page controlled yet, announces nothing', async ({ page }) => {
  await page.addInitScript(() => {
    const worker = { state: 'installed', postMessage() {}, addEventListener() {}, removeEventListener() {} };
    const registration = { waiting: worker, installing: null, addEventListener() {}, removeEventListener() {}, update: async () => {} };
    Object.defineProperty(navigator.serviceWorker, 'ready', { value: Promise.resolve(registration) });
  });
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Bonjour/ })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Mise à jour' })).toHaveCount(0);
});

test('readiness, HRV and stress say their status in words, not only in colour', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByText('48', { exact: true })).toBeVisible();
  await expect(page.getByText('Préparation basse')).toBeVisible();
  await expect(page.getByText('VFC basse')).toBeVisible();
  await expect(page.getByText('Stress élevé')).toBeVisible();
  await page.getByText('Stress élevé').scrollIntoViewIfNeeded();
  await page.locator('.glass-panel').filter({ hasText: 'Préparation basse' }).screenshot({ path: '../.context/robustness-statuses-1440.png', animations: 'disabled' });
});

for (const [path, ready] of [['/', /Bonjour/], ['/planning', 'Planning'], ['/log', 'Journal']] as const) {
  test(`every button has an accessible name on ${path}`, async ({ page }) => {
    await mockApi(page);
    await page.goto(path);
    await expect(page.getByRole('heading', { name: ready, level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await unnamedButtons(page)).toEqual([]);
    // Panel titles sit under the page title.
    expect(await page.locator('.glass-panel > h3').count()).toBe(0);
  });
}

test('the timezone select offers every zone, grouped by region', async ({ page }) => {
  await mockApi(page);
  await page.goto('/settings?tab=profile');
  const select = page.locator('label:has-text("Fuseau horaire") + select');
  await expect(select).toHaveValue('Europe/Paris');
  expect(await select.locator('option').count()).toBeGreaterThan(300);
  await expect(select.locator('optgroup[label="Asie"] option[value="Asia/Tokyo"]')).toHaveCount(1);
  await select.selectOption('Asia/Tokyo');
  await expect(select).toHaveValue('Asia/Tokyo');
});

for (const [theme, width] of [['pierre', 390], ['prune', 390], ['pierre', 1440]] as const) {
  test(`404 and notices fit at ${width} px — ${theme}`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 900 });
    await newVersion(page, false);
    await mockApi(page, theme);
    await page.goto('/nope');
    await expect(page.getByRole('heading', { name: 'Page introuvable' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.locator('.app-notices').evaluate((notices) => { notices.style.visibility = 'hidden'; });
    await page.screenshot({ path: `../.context/robustness-404-${theme}-${width}.png`, animations: 'disabled' });
    await page.locator('.app-notices').evaluate((notices) => { notices.style.visibility = ''; });
    await context.setOffline(true);
    await expect(page.getByRole('status', { name: 'Connexion' })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Mise à jour' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `../.context/robustness-notices-${theme}-${width}.png`, animations: 'disabled' });
    await context.setOffline(false);
  });
}
