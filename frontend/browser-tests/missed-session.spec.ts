import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer } from './dashboardAnswer';

/** Wednesday 14 October 2026, 20:15 in Paris: the evening a session was missed. */
const NOW = new Date('2026-10-14T18:15:00Z');
const DAY = '2026-10-14';

/** Where the screens land: ARE61_SCREENS, else the untracked `.context`. */
const SCREENS = process.env.ARE61_SCREENS ?? '../.context/missed-session';

const tempo = {
  id: 12, date: DAY, sport: 'running', session_type: 'tempo', target_duration_min: 50, target_distance_km: null,
  target_hr_zone: 'Z4', target_intensity: 'hard', description: null, source: 'manual', status: 'pending',
  garmin_workout_id: null, garmin_pushed_at: null, revision: 1,
};
const proposal = {
  id: 31, date: DAY, planned_session_id: 12, decision: 'move',
  reason: 'Séance manquée aujourd’hui : la séance tempo 50 min Z4 passe à jeudi 15 octobre, premier jour libre sans séance dure la veille ni le lendemain.',
  readiness_score: null, readiness_source: 'missed', acwr: null,
  original: { session_type: 'tempo', target_duration_min: 50, target_hr_zone: 'Z4', status: 'pending', date: DAY },
  adapted: { date: '2026-10-15' },
  applied_at: null, reverted_at: null, created_at: `${DAY}T18:00:00`, state: 'pending', revision: 1,
  session_revision: 1, readiness_measured_on: null, snoozed_until: null,
};

/** The athlete's evening; every request but the auth configuration is recorded. */
async function evening(page: Page, theme = 'encre') {
  const requests: string[] = [];
  const answers: unknown[] = [];
  await page.clock.setFixedTime(NOW);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    localStorage.setItem('arete.install.dismissed', '1');
    localStorage.setItem('arete.notifications.offered', '1');
  });
  const coach = () => {
    const last = answers.at(-1) as { action?: string } | undefined;
    const items = last ? [] : [{ kind: 'proposal', record: proposal, group: [proposal], members: [{ id: 31, revision: 1 }] }];
    return { date: DAY, items, remaining: 0, briefing: null };
  };
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    requests.push(`${request.method()} ${path}`);
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, display_name: 'HUNTER', theme } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, opted_in: false, available: true, version: 1 } });
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'fresh' } });
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/coach/today') return route.fulfill({ json: coach() });
    if (path === '/api/dashboard') {
      const last = answers.at(-1) as { action?: string } | undefined;
      const moved = last?.action === 'apply';
      const decision = moved ? { ...proposal, state: 'applied', applied_at: `${DAY}T18:16:00` } : last ? { ...proposal, state: 'dismissed' } : proposal;
      return route.fulfill({
        json: dashboardAnswer({
          date: DAY,
          planned: moved ? [] : [tempo],
          plan_today: { date: DAY, decisions: [decision] },
          coach: coach(),
          checkin: { date: DAY, sleep: 4, legs: 4, mood: null, note: null, answered_at: `${DAY}T06:00:00`, updated_at: `${DAY}T06:00:00` },
        }),
      });
    }
    if (path === '/api/coach/proposals/31/response') {
      const body = request.postDataJSON() as { action: string };
      answers.push(body);
      const state = body.action === 'apply' ? 'applied' : 'dismissed';
      return route.fulfill({ json: { ...proposal, state, revision: 2, garmin: body.action === 'apply' ? 'sent' : 'unchanged' } });
    }
    return route.fulfill({ json: [] });
  });
  return { requests, answers };
}

const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

for (const { width, height, name } of [
  { width: 375, height: 812, name: 'mobile' },
  { width: 1440, height: 1100, name: 'desktop' },
]) {
  test(`${name}: accept a missed session's replanning in one tap from the card`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const { requests, answers } = await evening(page);
    await page.goto('/');
    const card = page.getByRole('article').filter({ hasText: 'Séance manquée' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Proposé : Déplacée à jeudi 15 octobre');
    await expect(card).toContainText('Rien n’a encore changé.');
    const move = card.getByRole('button', { name: 'Déplacer' });
    for (const button of await card.getByRole('button').all()) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await card.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await noOverflow(page);
    await page.screenshot({ path: `${SCREENS}/card-${name}-dark.png`, animations: 'disabled' });

    // One tap.
    await move.click();
    const outcome = page.getByRole('status').filter({ hasText: 'Séance déplacée à jeudi 15 octobre.' });
    await expect(outcome).toBeVisible();
    await expect(outcome).toBeFocused();
    await expect(outcome).toContainText('Garmin : la séance est à jour sur ta montre.');
    expect(answers).toEqual([{ revision: 1, action: 'apply', group: [] }]);
    // The session left today: its row keeps the reason and « Rétablir ».
    await expect(page.getByText(proposal.reason)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rétablir la séance prévue' })).toBeVisible();
    await expect(page.getByRole('article').filter({ hasText: 'Séance manquée' })).toHaveCount(0);
    await noOverflow(page);
    await outcome.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: `${SCREENS}/accepted-${name}-dark.png`, animations: 'disabled' });
    expect(requests.filter((r) => r.startsWith('POST /api/agent'))).toEqual([]);
  });
}

test('mobile light: decline a missed session’s replanning in one tap', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { answers } = await evening(page, 'pierre');
  await page.goto('/');
  const card = page.getByRole('article').filter({ hasText: 'Séance manquée' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Pas maintenant' })).toHaveCount(0);
  await card.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: `${SCREENS}/card-mobile-light.png`, animations: 'disabled' });
  await card.getByRole('button', { name: 'Non merci' }).click();
  const outcome = page.getByRole('status').filter({ hasText: 'C’est noté : rien ne change.' });
  await expect(outcome).toBeFocused();
  expect(answers).toEqual([{ revision: 1, action: 'keep', group: [] }]);
  await noOverflow(page);
  await page.screenshot({ path: `${SCREENS}/declined-mobile-light.png`, animations: 'disabled' });
});
