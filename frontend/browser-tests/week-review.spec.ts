import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer, localDay } from './dashboardAnswer';

/** Where the screens land: ARE60_SCREENS, else the untracked `.context`. */
const SCREENS = process.env.ARE60_SCREENS ?? '../.context/week-review';

const review = {
  id: 7,
  week_start: localDay(-6),
  text: 'Semaine tenue : 4 séances sur 5, 4 h de volume. La charge monte vite : le fractionné de mardi passe en endurance.',
  source: 'agent',
  proposals: [
    { index: 0, planned_session_id: 21, date: localDay(2), session: 'intervals 50 min Z4', change: {}, before: {}, reason: 'Charge aiguë/chronique à 1.45 : la séance la plus dure passe en endurance Z2.' },
    { index: 1, planned_session_id: 22, date: localDay(7), session: 'long_run 90 min Z2', change: {}, before: {}, reason: 'Charge aiguë/chronique à 1.45 : sortie longue raccourcie à 75 min.' },
  ],
  applied: [] as number[],
  created_at: `${localDay()}T16:10:00`,
  applied_at: null as string | null,
};
const recap = {
  week_start: localDay(-6), week_end: localDay(), planned: 5, completed: 4,
  minutes_done: 240, minutes_planned: 300, adherence: 0.8, tsb: -8,
};

/** The athlete's Sunday evening; every request but the auth configuration is recorded. */
async function sunday(page: Page, theme = 'dark') {
  const requests: string[] = [];
  const accepted: unknown[] = [];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    localStorage.setItem('arete.install.dismissed', '1');
    localStorage.setItem('arete.notifications.offered', '1');
  });
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    requests.push(`${request.method()} ${path}`);
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, display_name: 'HUNTER', theme } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, opted_in: false, available: true, version: 1 } });
    if (path === '/api/dashboard') {
      const answered = accepted.length > 0;
      return route.fulfill({
        json: dashboardAnswer({
          checkin: { date: localDay(), sleep: 4, legs: 4, mood: null, note: null, answered_at: `${localDay()}T06:00:00`, updated_at: `${localDay()}T06:00:00` },
          weekly_review: answered ? null : { id: 7, week_start: review.week_start, open: 2 },
        }),
      });
    }
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'fresh' } });
    if (path === '/api/plan/review/week') {
      const applied = accepted.length ? [1] : [];
      return route.fulfill({
        json: { today: localDay(), review: { ...review, applied, applied_at: accepted.length ? `${localDay()}T18:30:00` : null }, recap },
      });
    }
    if (path === '/api/plan/review/7/accept') {
      accepted.push(request.postDataJSON());
      return route.fulfill({
        json: {
          applied: [1],
          stale: [],
          garmin: {
            state: 'done',
            sessions: [
              { planned_session_id: 22, date: localDay(7), session_type: 'long_run', outcome: 'sent' },
              { planned_session_id: 23, date: localDay(4), session_type: 'tempo', outcome: 'already' },
            ],
          },
          calendar: 'synced',
        },
      });
    }
    return route.fulfill({ json: [] });
  });
  return { requests, accepted };
}

const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

for (const { width, height, name } of [
  { width: 375, height: 812, name: 'mobile' },
  { width: 1440, height: 1100, name: 'desktop' },
]) {
  test(`${name}: from the dashboard entry, accept the ticked proposals and read each outcome`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const { requests, accepted } = await sunday(page);
    await page.goto('/');
    const entry = page.getByRole('link', { name: /Ta semaine est prête/ });
    await expect(entry).toBeVisible();
    await expect(entry).toContainText('2 propositions du coach');
    if (name === 'mobile') await page.screenshot({ path: `${SCREENS}/dashboard-entry-mobile-dark.png`, animations: 'disabled' });
    else await page.screenshot({ path: `${SCREENS}/dashboard-entry-desktop.png`, animations: 'disabled' });
    await entry.click();

    await expect(page).toHaveURL(/\/planning\/semaine$/);
    await expect(page.getByRole('heading', { name: 'Ma semaine', level: 1 })).toBeVisible();
    await expect(page.getByText('4/5')).toBeVisible();
    await expect(page.getByText('80 %')).toBeVisible();
    await expect(page.getByText(/Semaine tenue : 4 séances sur 5/)).toBeVisible();
    await noOverflow(page);
    const boxes = page.getByRole('checkbox');
    await expect(boxes).toHaveCount(2);
    await page.screenshot({ path: `${SCREENS}/ma-semaine-${name}${name === 'mobile' ? '-dark' : ''}.png`, fullPage: true, animations: 'disabled' });

    await boxes.first().uncheck(); // keep the intervals
    const accept = page.getByRole('button', { name: 'Accepter (1)' });
    const box = (await accept.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    await accept.click();
    const outcome = page.getByRole('status').filter({ hasText: 'Semaine acceptée' });
    await expect(outcome).toBeVisible();
    await expect(outcome).toContainText('1 proposition appliquée au planning.');
    await expect(outcome).toContainText('Sortie longue : envoyée sur Garmin Connect');
    await expect(outcome).toContainText('Seuil : déjà sur Garmin, inchangée');
    await expect(outcome).toContainText('Calendrier : à jour.');
    expect(accepted).toEqual([{ indices: [1] }]);
    // The focus stays on the page, not lost to the body.
    await expect(page.getByRole('heading', { name: 'Semaine acceptée' })).toBeFocused();
    await noOverflow(page);
    await page.screenshot({ path: `${SCREENS}/ma-semaine-${name}-accepted.png`, fullPage: true, animations: 'disabled' });
    expect(requests.filter((r) => r.startsWith('POST /api/agent'))).toEqual([]);
  });
}

test('mobile light: the screen, and « Ajuster » opens the coach with the review, composer empty', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { requests, accepted } = await sunday(page, 'light');
  await page.goto('/');
  await expect(page.getByRole('link', { name: /Ta semaine est prête/ })).toBeVisible();
  await page.screenshot({ path: `${SCREENS}/dashboard-entry-mobile-light.png`, animations: 'disabled' });
  // The push's link opens the screen directly.
  await page.goto('/planning/semaine');
  await expect(page.getByText(/Semaine tenue : 4 séances sur 5/)).toBeVisible();
  await page.screenshot({ path: `${SCREENS}/ma-semaine-mobile-light.png`, fullPage: true, animations: 'disabled' });

  await page.getByRole('button', { name: 'Ajuster avec le coach' }).click();
  const panel = page.getByRole('complementary', { name: 'Coach IA' });
  await expect(panel.getByText('Bilan de la semaine sélectionné · prêt à en parler')).toBeVisible();
  await expect(panel.getByLabel('Message au coach')).toHaveValue('');
  expect(accepted).toEqual([]);
  expect(requests.filter((r) => r.startsWith('POST /api/agent'))).toEqual([]);
  await page.screenshot({ path: `${SCREENS}/ajuster-mobile-light.png`, animations: 'disabled' });
});
