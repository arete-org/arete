import { test, expect } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer, localDay } from './dashboardAnswer';

const ANSWERED = { date: localDay(), sleep: 4, legs: 4, mood: null, note: null, answered_at: `${localDay()}T05:12:00+00:00`, updated_at: `${localDay()}T05:12:00+00:00` };

// Local fixtures keep layout checks independent of training data or model calls.
test('desktop aligns the brand and content, uses the workspace and reflows beside the coach', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('arete.coach-display.v2', 'sidebar'));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
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
  // Settled: the form curve's lazy read has answered (no load in this fixture).
  await expect(page.getByText(/Pas encore de charge enregistrée/)).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    const brand = (await page.getByRole('link', { name: 'Arete · Accueil' }).boundingBox())!;
    const title = (await heading.boundingBox())!;
    const grid = (await page.locator('.dashboard-grid').boundingBox())!;
    const primary = (await page.locator('.dashboard-primary').boundingBox())!;
    const secondary = (await page.locator('.dashboard-secondary').boundingBox())!;
    expect(Math.abs(brand.x - title.x)).toBeLessThan(1);
    expect(grid.width).toBeGreaterThan(width * .9);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    expect(Math.abs(primary.y - secondary.y)).toBeLessThan(1);
    expect(secondary.x).toBeGreaterThan(primary.x + primary.width);
    await expect(page.getByRole('link', { name: 'Saisir une séance', exact: true })).toBeInViewport();
    await expect(page.getByRole('heading', { name: 'RÉCUPÉRATION', exact: true })).toBeInViewport();
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Ouvrir le coach' }).filter({ visible: true }).click();
  const panel = page.getByRole('complementary', { name: 'Coach IA' });
  await panel.getByLabel('Message au coach').fill('Mon brouillon reste ici.');
  const content = (await page.locator('.dashboard-grid').boundingBox())!;
  const coach = (await panel.boundingBox())!;
  expect(content.x + content.width).toBeLessThan(coach.x);
  const primary = (await page.locator('.dashboard-primary').boundingBox())!;
  const secondary = (await page.locator('.dashboard-secondary').boundingBox())!;
  expect(secondary.y).toBeGreaterThanOrEqual(primary.y + primary.height);

  // A larger screen can retain both columns even with the same 520 px coach.
  await page.setViewportSize({ width: 1920, height: 1000 });
  const widePrimary = (await page.locator('.dashboard-primary').boundingBox())!;
  const wideSecondary = (await page.locator('.dashboard-secondary').boundingBox())!;
  expect(Math.abs(widePrimary.y - wideSecondary.y)).toBeLessThan(1);
  expect(wideSecondary.x).toBeGreaterThan(widePrimary.x + widePrimary.width);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.getByLabel('Message au coach')).toHaveValue('Mon brouillon reste ici.');
  await panel.getByRole('button', { name: 'Masquer le coach' }).click();
  await expect(heading).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('link', { name: 'Saisir une séance', exact: true })).toBeVisible();
});
