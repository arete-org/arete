import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer, localDay } from './dashboardAnswer';

/** The dashboard with today unanswered; every request but the auth configuration is recorded. */
async function morning(page: Page, theme = 'encre', replanned = false) {
  const requests: string[] = [];
  const answers: Record<string, unknown>[] = [];
  const at = `${localDay()}T05:12:00+00:00`;
  const stored = () => (answers.length ? { date: localDay(), ...answers.at(-1), answered_at: at, updated_at: at } : null);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    localStorage.setItem('arete.install.dismissed', '1');
    localStorage.setItem('arete.notifications.offered', '1');
  });
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    requests.push(`${request.method()} ${path}`);
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, display_name: 'HUNTER', theme } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, opted_in: false, available: true, version: 1 } });
    if (path === '/api/dashboard') return route.fulfill({ json: dashboardAnswer({ checkin: stored() }) });
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'fresh' } });
    if (path === `/api/checkins/${localDay()}` && request.method() === 'PUT') {
      const body = request.postDataJSON();
      answers.push(body);
      return route.fulfill({ json: { ...stored(), replanned } });
    }
    return route.fulfill({ json: [] });
  });
  return { requests, answers };
}

const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

for (const { width, height } of [{ width: 375, height: 812 }, { width: 1440, height: 1100 }]) {
  test(`${width} px: the morning check-in takes three taps, then hides`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const { requests, answers } = await morning(page);
    await page.goto('/');
    const card = page.getByRole('region', { name: 'Check-in du matin' });
    await expect(card).toBeVisible();
    // Before the briefing, which it feeds.
    const ask = (await card.boundingBox())!;
    const briefing = (await page.getByRole('heading', { name: 'Briefing du jour' }).boundingBox())!;
    expect(ask.y).toBeLessThan(briefing.y);
    await noOverflow(page);
    for (const chip of await card.getByRole('radio').all()) {
      const box = (await chip.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
    }

    const taps = [
      card.getByRole('radiogroup', { name: 'Sommeil ?' }).getByRole('radio', { name: '2 sur 5 — mauvais', exact: true }),
      card.getByRole('radiogroup', { name: 'Jambes ?' }).getByRole('radio', { name: '4 sur 5 — légères', exact: true }),
      card.getByRole('button', { name: 'Valider' }),
    ];
    for (const tap of taps) await tap.click();
    expect(taps).toHaveLength(3);

    await expect(card).toBeHidden();
    expect(answers).toEqual([{ sleep: 2, legs: 4, mood: null, note: null }]);
    // After the answer, the primary briefing and session action remain above the fold.
    if (width === 1440) {
      await expect(page.getByRole('heading', { name: 'Briefing du jour' })).toBeInViewport();
      await expect(page.getByRole('link', { name: 'Saisir une séance', exact: true })).toBeInViewport();
    }
    // One read again after the answer (it carries the answer: the card stays hidden).
    await expect.poll(() => requests.filter((r) => r === 'GET /api/dashboard').length).toBe(2);
    await page.waitForLoadState('networkidle');
    await expect(card).toBeHidden();
    expect(requests.filter((r) => r === 'GET /api/dashboard')).toHaveLength(2);
  });
}

test('the push link brings back a card put off for the day, focused, and a proposal refreshes the page', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { requests, answers } = await morning(page, 'encre', true);
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Check-in du matin' });
  await card.getByRole('button', { name: /Plus tard/ }).click();
  await expect(card).toBeHidden();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Briefing du jour' })).toBeVisible();
  await expect(card).toBeHidden(); // remembered for the day

  await page.goto('/?checkin=1');
  await expect(card).toBeVisible();
  const first = card.getByRole('radio', { name: '1 sur 5 — très mauvais', exact: true });
  await expect(first).toBeFocused();
  // Used once: a reload or the installed app reopening keeps « Plus tard ».
  await expect(page).not.toHaveURL(/checkin=1/);
  // Keyboard only: arrows move within a question, Tab to the next.
  await page.keyboard.press('ArrowRight');
  await expect(card.getByRole('radio', { name: '2 sur 5 — mauvais', exact: true })).toBeChecked();
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowRight');
  await expect(card.getByRole('radio', { name: '2 sur 5 — lourdes', exact: true })).toBeChecked();
  const before = requests.filter((r) => r === 'GET /api/dashboard').length;
  await card.getByRole('button', { name: 'Valider' }).click();
  await expect(card).toBeHidden();
  expect(answers).toEqual([{ sleep: 2, legs: 2, mood: null, note: null }]);
  await expect.poll(() => requests.filter((r) => r === 'GET /api/dashboard').length).toBe(before + 1);
});

for (const theme of ['encre', 'pierre']) {
  test(`375 px ${theme}: the card before and after answering`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await morning(page, theme);
    await page.goto('/');
    const card = page.getByRole('region', { name: 'Check-in du matin' });
    await expect(card).toBeVisible();
    await expect(page.getByText('Prépare tes prochaines séances.')).toBeVisible();
    await expect(page.getByText('Pas encore d’objectif de course.')).toBeVisible();
    await page.screenshot({ path: `../.context/checkin/${theme}-before.png`, animations: 'disabled' });
    await card.getByRole('radio', { name: '3 sur 5 — moyen', exact: true }).click();
    await card.getByRole('radio', { name: '2 sur 5 — lourdes', exact: true }).click();
    await page.screenshot({ path: `../.context/checkin/${theme}-answering.png`, animations: 'disabled' });
    await card.getByRole('button', { name: 'Valider' }).click();
    await expect(card).toBeHidden();
    await page.screenshot({ path: `../.context/checkin/${theme}-after.png`, animations: 'disabled' });
  });
}
