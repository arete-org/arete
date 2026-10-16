import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer } from './dashboardAnswer';

/** Wednesday 14 October 2026, 17:30 in Paris: the evening the plan stops fitting. */
const NOW = new Date('2026-10-14T15:30:00Z');
const DAY = '2026-10-14';

/** Where the screens land: ARE61_SCREENS, else the untracked `.context`. */
const SCREENS = process.env.ARE61_SCREENS ?? '../.context/renegotiate';

const tempo = {
  id: 12, date: DAY, sport: 'running', session_type: 'tempo', target_duration_min: 50, target_distance_km: null,
  target_hr_zone: 'Z4', target_intensity: 'hard', description: null, source: 'manual', status: 'pending',
  garmin_workout_id: null, garmin_pushed_at: null, revision: 1,
};
const menu = {
  session_id: 12,
  date: DAY,
  version: '0123456789abcdef',
  blocked: null,
  reasons: [
    {
      id: 'tired', label: 'Je suis cuit', note: null,
      options: [
        { id: 'lighter', decision: 'ease', label: 'Version allégée', detail: 'Endurance 35 min Z2' },
        { id: 'move', decision: 'move', label: 'Déplacer à jeudi 15 octobre', detail: 'Premier jour libre, sans séance dure la veille ni le lendemain.' },
      ],
    },
    {
      id: 'no_time', label: 'Pas le temps', note: null,
      options: [
        { id: 'shorter', decision: 'ease', label: 'Version courte', detail: 'Tempo 35 min Z4' },
        { id: 'move', decision: 'move', label: 'Déplacer à jeudi 15 octobre', detail: 'Premier jour libre, sans séance dure la veille ni le lendemain.' },
      ],
    },
    {
      id: 'pain', label: 'Douleur / gêne', note: 'Avec une douleur, ni report ni séance plus dure. Si elle dure, parles-en au coach.',
      options: [
        { id: 'rest', decision: 'rest', label: 'Repos aujourd’hui', detail: 'La séance est sautée.' },
        { id: 'easy', decision: 'replace_easy', label: 'Très facile', detail: 'Récupération 20 min Z1' },
      ],
    },
  ],
};
const eased = {
  id: 5, date: DAY, planned_session_id: 12, decision: 'ease',
  reason: 'Je suis cuit : la séance tempo 50 min Z4 devient endurance 35 min Z2.',
  readiness_score: null, readiness_source: null, acwr: null,
  original: { session_type: 'tempo', target_duration_min: 50, target_hr_zone: 'Z4', status: 'pending' },
  adapted: { session_type: 'endurance', target_duration_min: 35, target_hr_zone: 'Z2' },
  applied_at: `${DAY}T17:30:00`, reverted_at: null, created_at: `${DAY}T17:30:00`, state: 'applied', revision: 1,
};
const moved = {
  ...eased, decision: 'move', adapted: { date: '2026-10-15' },
  reason: 'Pas le temps : la séance tempo 50 min Z4 passe à jeudi 15 octobre.',
};

/** The athlete's evening; every request but the auth configuration is recorded. */
async function evening(page: Page, theme = 'dark') {
  const requests: string[] = [];
  const chosen: unknown[] = [];
  await page.clock.setFixedTime(NOW);
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
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'fresh' } });
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/dashboard') {
      const last = chosen.at(-1) as { option?: string } | undefined;
      const decision = last?.option === 'move' ? moved : last ? eased : null;
      const planned =
        last?.option === 'move'
          ? []
          : last
            ? [{ ...tempo, session_type: 'endurance', target_duration_min: 35, target_hr_zone: 'Z2', target_intensity: 'easy', status: 'modified', revision: 2 }]
            : [tempo];
      return route.fulfill({
        json: dashboardAnswer({
          date: DAY,
          planned,
          plan_today: { date: DAY, decisions: decision ? [decision] : [] },
          checkin: { date: DAY, sleep: 4, legs: 4, mood: null, note: null, answered_at: `${DAY}T06:00:00`, updated_at: `${DAY}T06:00:00` },
        }),
      });
    }
    // The choice refreshes the coach card too.
    if (path === '/api/coach/today') return route.fulfill({ json: { date: DAY, items: [], remaining: 0, briefing: null } });
    if (path === '/api/plan/today/sessions/12/options') return route.fulfill({ json: menu });
    if (path === '/api/plan/today/sessions/12/renegotiate') {
      const body = request.postDataJSON() as { option: string };
      chosen.push(body);
      const decision = body.option === 'move' ? moved : eased;
      return route.fulfill({
        json: { decision, date: body.option === 'move' ? '2026-10-15' : DAY, garmin: body.option === 'move' ? 'sent' : 'disabled' },
      });
    }
    return route.fulfill({ json: [] });
  });
  return { requests, chosen };
}

const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

for (const { width, height, name } of [
  { width: 375, height: 812, name: 'mobile' },
  { width: 1440, height: 1100, name: 'desktop' },
]) {
  test(`${name}: renegotiate today's session in two taps, the outcome reported apart`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const { requests, chosen } = await evening(page);
    await page.goto('/');
    const modify = page.getByRole('button', { name: 'Modifier', exact: true });
    await expect(modify).toBeVisible();
    // Nothing is read for the menu until it opens.
    expect(requests.filter((r) => r.includes('/options'))).toEqual([]);
    expect((await modify.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    // Tap 1: the reasons and their options.
    await modify.click();
    await expect(page.getByRole('heading', { name: 'Je suis cuit' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Douleur / gêne' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Version allégée/ })).toBeFocused();
    expect(requests.filter((r) => r.includes('/options'))).toEqual(['GET /api/plan/today/sessions/12/options']);
    for (const option of await page.getByRole('group', { name: 'Modifier la séance du jour' }).getByRole('button').all()) {
      expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await noOverflow(page);
    await page.getByRole('heading', { name: 'Pas le temps' }).evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: `${SCREENS}/menu-${name}-dark.png`, animations: 'disabled' });

    // Tap 2: one option, written once.
    await page.getByRole('button', { name: /Version allégée/ }).click();
    const outcome = page.getByRole('status').filter({ hasText: 'Séance modifiée' });
    await expect(outcome).toBeVisible();
    await expect(outcome).toBeFocused();
    await expect(outcome).toContainText('Séance modifiée : Endurance 35 min Z2.');
    await expect(outcome).toContainText('Envoi automatique vers Garmin désactivé');
    expect(chosen).toEqual([{ reason: 'tired', option: 'lighter', version: menu.version }]);
    // The card reads the written session and its reason, with « Rétablir ».
    await expect(page.getByText(eased.reason)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rétablir la séance prévue' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Modifier', exact: true })).toHaveCount(0);
    await noOverflow(page);
    await page.screenshot({ path: `${SCREENS}/outcome-${name}-dark.png`, animations: 'disabled', fullPage: name === 'mobile' });
    expect(requests.filter((r) => r.startsWith('POST /api/agent'))).toEqual([]);
  });
}

test('mobile light: a move leaves the session’s row with its reason, Garmin reported', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { chosen } = await evening(page, 'light');
  await page.goto('/');
  await page.getByRole('button', { name: 'Modifier', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pas le temps' })).toBeVisible();
  await page.getByRole('heading', { name: 'Pas le temps' }).evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: `${SCREENS}/menu-mobile-light.png`, animations: 'disabled' });
  await page
    .getByRole('region', { name: 'Pas le temps' })
    .getByRole('button', { name: /Déplacer à jeudi 15 octobre/ })
    .click();
  const outcome = page.getByRole('status').filter({ hasText: 'Séance déplacée' });
  await expect(outcome).toContainText('Séance déplacée à jeudi 15 octobre.');
  await expect(outcome).toContainText('Garmin : la séance est à jour sur ta montre.');
  await expect(page.getByText(moved.reason)).toBeVisible();
  await expect(page.getByText('→ jeudi 15 octobre')).toBeVisible();
  expect(chosen).toEqual([{ reason: 'no_time', option: 'move', version: menu.version }]);
  await noOverflow(page);
  await page.screenshot({ path: `${SCREENS}/outcome-move-mobile-light.png`, animations: 'disabled', fullPage: true });
});

test('« Autre… » opens the coach with the session selected, composer empty', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { requests, chosen } = await evening(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Modifier', exact: true }).click();
  await page.getByRole('button', { name: /Autre… en parler au coach/ }).click();
  const panel = page.getByRole('complementary', { name: 'Coach IA' });
  await expect(panel.getByText('Séance du jour sélectionnée · prêt à en parler')).toBeVisible();
  await expect(panel.getByLabel('Message au coach')).toHaveValue('');
  expect(chosen).toEqual([]);
  expect(requests.filter((r) => r.startsWith('POST /api/agent'))).toEqual([]);
  await page.screenshot({ path: `${SCREENS}/autre-mobile-dark.png`, animations: 'disabled' });
});
