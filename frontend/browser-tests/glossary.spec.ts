import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer, localDay } from './dashboardAnswer';

const headline = (display: string) => ({
  display,
  value: 1,
  unit: '',
  previous: null,
  delta: null,
  delta_pct: null,
  better: 'neutral',
});
const CARDS = ['volume', 'pmc', 'zones', 'sports', 'decoupling', 'pace', 'elevation', 'cadence', 'vam', 'descent', 'risk', 'weeks', 'readiness', 'hrv', 'sleep', 'resting_hr'];

/** Every analytics card without a series; the form card carries its fraîcheur and fatigue, the risk card the ACWR. */
function overview() {
  const cards = Object.fromEntries(
    CARDS.map((name) => [
      name,
      { headline: headline('42'), secondary: [], insight: { text: 'Mesures de la période.', tone: 'neutral' }, series: [] },
    ]),
  );
  cards.pmc.secondary = [headline('-8'), headline('50')];
  cards.risk.headline = headline('1,27');
  return {
    period: '30d',
    bucket: 'day',
    start: '2026-09-19',
    end: '2026-10-18',
    prev_start: null,
    prev_end: null,
    cards,
    hr_zone_model: { basis: 'lthr', reference: 172, boundaries: [146, 153, 163, 172], ranges: [] },
  };
}

async function stubApi(page: Page) {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, theme: 'pierre', user_id: 1 } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, available: true } });
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'disconnected' } });
    if (path === '/api/analytics/overview') return route.fulfill({ json: overview() });
    if (path === '/api/onboarding') return route.fulfill({ json: { status: 'completed', revision: 1 } });
    if (path === '/api/dashboard')
      return route.fulfill({
        json: dashboardAnswer({
          workload: { ...dashboardAnswer().workload, acwr: 1.27, acwr_zone: 'optimal' },
          checkin: { date: localDay(), sleep: 4, legs: 4, mood: null, note: null, answered_at: `${localDay()}T05:12:00+00:00`, updated_at: `${localDay()}T05:12:00+00:00` },
        }),
      });
    return route.fulfill({ json: [] });
  });
}

for (const width of [1440, 390, 320]) {
  test(`a metric's "?" opens its glossary entry at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubApi(page);

    await page.goto('/analytics');
    const question = page.getByRole('link', { name: 'Qu’est-ce que le ratio charge aiguë / chronique (ACWR) ?' });
    await question.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `../.context/arete-glossary-links-${width}.png`, animations: 'disabled' });
    await question.click();

    await expect(page).toHaveURL(/\/analytics\/lexique#acwr$/);
    const term = page.getByRole('heading', { level: 3, name: 'Ratio charge aiguë / chronique (ACWR)' });
    await expect(term).toBeFocused();
    await expect(term).toBeInViewport();
    const entry = page.locator('article#acwr');
    await expect(entry).toHaveAttribute('data-current', 'true');
    await expect(entry).toContainText('De 0,8 à 1,3 : zone optimale');
    // Below the sticky desktop bar, not under it.
    const top = await term.evaluate((element) => element.getBoundingClientRect().top);
    expect(top).toBeGreaterThan(width >= 768 ? 56 : 0);

    // Another term from the page itself: the search, then its anchor.
    await page.getByLabel('Rechercher un terme').fill('variabilite');
    await expect(page.locator('article')).toHaveCount(1);
    await expect(page.locator('article#vfc')).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `../.context/arete-glossary-${width}.png`, animations: 'disabled' });
    expect(errors).toEqual([]);
  });
}

for (const width of [1440, 390, 320]) {
  test(`the analytics page leads to the glossary at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubApi(page);
    await page.goto('/analytics');
    // The banner's button from a tablet up; on a phone the sticky banner keeps one row.
    const banner = page.getByRole('link', { name: 'Lexique', exact: true });
    if (width >= 640) await expect(banner).toBeVisible();
    else await expect(banner).toBeHidden();
    await page.getByRole('link', { name: 'Lexique : les termes et les seuils expliqués' }).click();
    await expect(page).toHaveURL(/\/analytics\/lexique$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Lexique' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const width of [1440, 390, 320]) {
  test(`the dashboard's load ratio and form bars open their entries at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Détails de ma forme' }).click();
    await expect(page.getByText('1,27', { exact: true })).toBeVisible();
    // Each bar's "?" names its bar: the readiness is linked from three places.
    await expect(page.getByRole('link', { name: 'Qu’est-ce que la préparation ? (barre Préparation)' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Qu’est-ce que la charge d’entraînement (TSS) ? (barre Charge de la semaine)' })).toBeVisible();
    await page.getByRole('link', { name: 'Qu’est-ce que le ratio charge aiguë / chronique (ACWR) ?' }).click();
    await expect(page).toHaveURL(/\/analytics\/lexique#acwr$/);
    const term = page.getByRole('heading', { level: 3, name: 'Ratio charge aiguë / chronique (ACWR)' });
    await expect(term).toBeFocused();
    await expect(term).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
