import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer, localDay } from './dashboardAnswer';

const at = (day: string) => `${day}T07:00:00Z`;
const pain = (id: number, offset: number, fields: Record<string, unknown> = {}) => ({
  id, date: localDay(offset), area: 'knee', side: 'left', intensity: 5, note: null,
  label: 'genou, côté gauche', created_at: at(localDay(offset)), updated_at: at(localDay(offset)), ...fields,
});
const weight = (offset: number, kg: number) => ({
  date: localDay(offset), weight_kg: kg, source: 'manual', created_at: at(localDay(offset)), updated_at: at(localDay(offset)),
});

const TREND = {
  start: localDay(-55), end: localDay(),
  pain: [pain(2, 0, { area: 'lower_back', side: null, intensity: 7, label: 'bas du dos', note: 'au réveil, raide une heure' }), pain(1, -3)],
  weights: [weight(-20, 72.2), weight(-6, 71.8), weight(0, 71.4)],
  weight: { latest: weight(0, 71.4), average_7d: 71.6, change_kg: -0.8, change_since: localDay(-20) },
  areas: [
    { area: 'lower_back', side: null, label: 'bas du dos', last_date: localDay(), last_intensity: 7, max_intensity: 7, entries: 1 },
    { area: 'knee', side: 'left', label: 'genou, côté gauche', last_date: localDay(-3), last_intensity: 5, max_intensity: 5, entries: 1 },
  ],
};

const REPORT = {
  start: localDay(-52), end: localDay(),
  weeks: Array.from({ length: 8 }, (_, i) => ({
    week_start: localDay(-52 + i * 7), week_end: localDay(Math.min(0, -46 + i * 7)), sessions: i % 3, duration_min: 40 * (i % 3),
    distance_km: 8 * (i % 3), tss: 45 * (i % 3), acwr: i ? 0.9 + i / 20 : null,
  })),
  sessions: Array.from({ length: 12 }, (_, i) => ({
    date: localDay(-50 + i * 4), kind: i % 4 ? 'cardio' : 'strength', sport: i % 4 ? 'running' : 'strength',
    duration_min: 45, distance_km: i % 4 ? 9.4 : null,
    avg_hr: i % 4 ? 142 : null, rpe: 5, tss: 52,
  })),
  pain: [...TREND.pain].reverse(),
  pain_areas: TREND.areas,
  weights: TREND.weights,
  weight: TREND.weight,
  readiness: [{ date: localDay(), garmin_readiness: 58, readiness: 61, sleep_score: 74, resting_hr: 49, hrv: 52 }],
  checkins: [{ date: localDay(), sleep: 2, legs: 3, mood: 4 }],
  totals: { sessions: 12, duration_min: 540, pain_entries: 2, max_pain: 7 },
};

/** Every request but the auth configuration is recorded; the body log answers from memory. */
async function serve(page: Page) {
  const requests: string[] = [];
  const bodies: unknown[] = [];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    localStorage.setItem('arete.install.dismissed', '1');
    localStorage.setItem('arete.notifications.offered', '1');
  });
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    requests.push(`${request.method()} ${path}`);
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, display_name: 'Greg', theme: 'encre' } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, opted_in: false, available: true, version: 1 } });
    if (path === '/api/dashboard') return route.fulfill({ json: dashboardAnswer({ checkin: { date: localDay(), sleep: 4, legs: 4, mood: null, note: null, answered_at: at(localDay()), updated_at: at(localDay()) } }) });
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'fresh' } });
    if (path === '/api/body') return route.fulfill({ json: TREND });
    if (path === '/api/body/report') return route.fulfill({ json: REPORT });
    if (path === '/api/body/pain' && request.method() === 'POST') {
      bodies.push(request.postDataJSON());
      return route.fulfill({ status: 201, json: pain(9, 0, request.postDataJSON()) });
    }
    if (/^\/api\/body\/(pain\/\d+|weight\/[\d-]+)$/.test(path) && request.method() === 'DELETE') return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ json: [] });
  });
  return { requests, bodies };
}

const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

for (const { width, height } of [{ width: 390, height: 844 }, { width: 1440, height: 1100 }]) {
  test(`${width} px: a pain is noted from the dashboard in three choices, without a read`, async ({ page }) => {
    // It is already tomorrow for this athlete in Paris, regardless of the runner's zone.
    await page.clock.setFixedTime(new Date('2026-10-23T22:30:00Z'));
    await page.setViewportSize({ width, height });
    const { requests, bodies } = await serve(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Détails de ma forme' }).click();
    const card = page.getByRole('heading', { name: 'Douleur ou poids' }).locator('xpath=ancestor::div[contains(@class,"glass-panel")][1]');
    await card.getByRole('button', { name: 'Signaler une douleur' }).click();
    const form = card.getByRole('form', { name: 'Signaler une douleur' });
    await expect(form).toBeVisible();
    await noOverflow(page);
    for (const chip of await form.getByRole('radio').all()) {
      expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await form.getByLabel('Zone').selectOption('knee');
    await form.getByRole('radio', { name: 'Gauche' }).click();
    await form.getByRole('radio', { name: '5 sur 10' }).click();
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(card.getByRole('status')).toHaveText('Douleur enregistrée : genou, côté gauche, 5/10.');
    await expect(form).toBeHidden();
    expect(bodies).toEqual([{ date: '2026-10-24', area: 'knee', side: 'left', intensity: 5, note: null }]);
    // The card reads nothing: the dashboard's requests are unchanged by it.
    expect(requests.filter((r) => r.startsWith('GET /api/body'))).toEqual([]);
  });

  test(`${width} px: the Santé page shows each area and the weight, and erases in two taps`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const { requests } = await serve(page);
    await page.goto('/sante');
    await expect(page.getByRole('heading', { level: 1, name: 'Santé' })).toBeVisible();
    const areas = page.getByRole('table', { name: 'Douleurs par zone sur 8 semaines' });
    await expect(areas.getByRole('row')).toHaveCount(3);
    await expect(areas.getByRole('rowheader', { name: 'Bas du dos' })).toBeVisible();
    await expect(page.getByText(/71,4 kg le .+ \(−0,8 kg depuis le/)).toBeVisible();
    await expect(page.getByRole('img', { name: /^Poids : de 72,2 kg/ })).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: `../.context/body-log/sante-${width}.png`, fullPage: true, animations: 'disabled' });

    const entries = page.getByRole('list', { name: 'Douleurs notées' });
    await entries.getByRole('button', { name: /^Supprimer la douleur du .+ \(bas du dos\)$/ }).click();
    expect(requests.filter((r) => r.startsWith('DELETE'))).toEqual([]); // one tap asks first
    await entries.getByRole('button', { name: 'Supprimer définitivement' }).click();
    await expect.poll(() => requests.filter((r) => r.startsWith('DELETE'))).toEqual(['DELETE /api/body/pain/2']);

    await entries.getByRole('button', { name: /^Corriger la douleur du .+ \(genou, côté gauche\)$/ }).click();
    const edit = page.getByRole('form', { name: 'Corriger la douleur' });
    await expect(edit.getByRole('radio', { name: '5 sur 10' })).toBeChecked();
    await expect(edit.getByLabel('Zone')).toHaveValue('knee');
  });

  test(`${width} px: the physio report prints alone, light whatever the theme`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await serve(page);
    await page.goto('/sante/rapport');
    const report = page.getByRole('article', { name: 'Rapport d’entraînement et de santé' });
    await expect(report).toBeVisible();
    await expect(report.getByText(/8 semaines · Greg$/)).toBeVisible();
    await expect(report.getByText('au réveil, raide une heure')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Imprimer ou enregistrer en PDF' })).toBeEnabled();
    await noOverflow(page);
    await page.screenshot({ path: `../.context/body-log/rapport-${width}.png`, fullPage: true, animations: 'disabled' });

    await page.emulateMedia({ media: 'print', reducedMotion: 'reduce' });
    await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Imprimer ou enregistrer en PDF' })).toBeHidden();
    await expect(report).toBeVisible();
    // Dark ink on white paper, though the athlete's theme is Encre.
    const colors = await report.evaluate((el) => ({
      ink: getComputedStyle(el.querySelector('h1')!).color,
      page: getComputedStyle(document.body).backgroundColor,
    }));
    expect(colors).toEqual({ ink: 'rgb(28, 41, 39)', page: 'rgb(255, 255, 255)' });
    await page.screenshot({ path: `../.context/body-log/rapport-print-${width}.png`, fullPage: true, animations: 'disabled' });
  });
}
