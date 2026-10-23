import { test, expect } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer, localDay } from './dashboardAnswer';

const ANSWERED = { date: localDay(), sleep: 4, legs: 4, mood: null, note: null, answered_at: `${localDay()}T05:12:00+00:00`, updated_at: `${localDay()}T05:12:00+00:00` };

// Local fixtures keep layout checks independent of training data or model calls.
test('desktop home and embedded coach share centered page gutters', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('arete.coach-display.v2', 'sidebar'));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    // This settled dashboard belongs to an athlete who already completed setup.
    if (path === '/api/onboarding') return route.fulfill({ json: { status: 'completed', revision: 1 } });
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, theme: 'odyssey', display_name: 'HUNTER' } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, available: true } });
    // The morning answered: the open check-in card scrolls the page until then (checkin.spec.ts).
    if (path === '/api/dashboard') return route.fulfill({ json: dashboardAnswer({ checkin: ANSWERED }) });
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'fresh', complete: true } });
    return route.fulfill({ json: [] });
  });
  await page.goto('/');
  const heading = page.getByRole('heading', { name: 'Bonjour, HUNTER' });
  await expect(heading).toBeVisible();
  // The compact home is settled without fetching the detailed form curve.
  await expect(page.getByText('Prépare tes prochaines séances.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Terminer ma configuration' })).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    const brand = (await page.getByRole('link', { name: 'Arete · Accueil' }).boundingBox())!;
    const title = (await heading.boundingBox())!;
    const grid = (await page.locator('.dashboard-overview').first().boundingBox())!;
    const primary = (await page.locator('.dashboard-overview > .glass-panel').nth(0).boundingBox())!;
    const secondary = (await page.locator('.dashboard-overview > .glass-panel').nth(1).boundingBox())!;
    // The compact navbar and page have distinct gutters in the retained redesign.
    expect(brand.x).toBe(20);
    expect(title.x).toBe((width - 960) / 2);
    expect(grid.width).toBe(960);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(Math.abs(primary.y - secondary.y)).toBeLessThan(1);
    expect(secondary.x).toBeGreaterThan(primary.x + primary.width);
    await expect(page.getByRole('link', { name: 'Saisir une séance', exact: true })).toBeInViewport();
    await expect(page.getByRole('heading', { name: 'Tes repères', exact: true })).toBeInViewport();
  }

  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByRole('button', { name: 'Ouvrir le coach' }).filter({ visible: true }).click();
  const panel = page.getByRole('region', { name: 'Coach IA' });
  await panel.getByLabel('Message au coach').fill('Mon brouillon reste ici.');
  await expect(page).toHaveURL(/\/coach$/);
  await expect(panel).toHaveCSS('position', 'relative');
  await expect(page.getByRole('main').getByRole('region', { name: 'Coach IA' })).toBeVisible();
  await expect(heading).toHaveCount(0);
  for (const width of [1280, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    const coach = (await panel.boundingBox())!;
    const expected = Math.min(width * .9, 1296);
    expect(coach.width).toBe(expected);
    expect(coach.x).toBe((width - expected) / 2);
    const recent = (await panel.getByRole('complementary', { name: 'Conversations récentes' }).boundingBox())!;
    const conversation = (await panel.locator('.coach-conversation').boundingBox())!;
    const methods = (await panel.getByRole('complementary', { name: 'Méthodes utiles' }).boundingBox())!;
    expect(Math.abs(recent.y - conversation.y)).toBeLessThan(1);
    expect(Math.abs(methods.y - conversation.y)).toBeLessThan(1);
    await expect(panel.getByLabel('Message au coach')).toBeInViewport();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.getByLabel('Message au coach')).toHaveValue('Mon brouillon reste ici.');
  await panel.getByRole('button', { name: 'Retour à la page' }).click();
  await expect(heading).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('link', { name: 'Saisir une séance', exact: true })).toBeVisible();
});
