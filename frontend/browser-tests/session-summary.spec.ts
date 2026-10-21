import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import type { ActivityDetail, StrengthSession } from '../src/types';
import { detail } from './analysis-data';

const tomorrow = {
  id: 40, date: '2026-10-09', sport: 'running', session_type: 'endurance', description: 'Footing souple',
  target_duration_min: 45, target_distance_km: null, target_hr_zone: 'Z2', status: 'pending' as const,
};

const run: ActivityDetail = {
  ...detail,
  intervals: null,
  feedback: {
    text: 'Footing bien dosé : le cardio est resté en endurance du début à la fin. Garde ce rythme pour la sortie longue de dimanche.',
    source: 'agent', trigger: 'sync', created_at: null,
  },
  session: { ...detail.session, name: 'Footing du matin', rpe: null },
  summary: { rule_feedback: null, strength: null, next_day: { date: '2026-10-09', relative: 'tomorrow', planned: [tomorrow], proposals: [], next: null } },
};

const strength: ActivityDetail = {
  ...detail,
  intervals: null, metrics: null, streams: null, route: null, laps: [], zones: null, terrain: null, weather: null, feedback: null,
  strength_log_id: 4,
  session: {
    ...detail.session, id: 301, sport: 'strength', name: 'Jambes', distance_m: null, avg_pace_sec_km: null,
    avg_speed_mps: null, ascent_m: null, avg_cadence: null, rpe: 7,
  },
  summary: {
    rule_feedback: 'Séance musculation terminée — 4250 kg de volume total sur quadriceps, fessiers. RPE ressenti : 7/10.',
    strength: { tonnage_kg: 4250, sets: 18, top_e1rm: { exercise: 'Squat', e1rm_kg: 120, previous_kg: 117.5, previous_date: '2026-10-01' } },
    next_day: {
      date: '2026-10-09', relative: 'today', planned: [{ ...tomorrow, session_type: 'intervals', description: null, target_duration_min: 50, target_hr_zone: 'Z4' }],
      proposals: [{ planned_session_id: 40, decision: 'ease', reason: 'Préparation Garmin 55/100 : fractionné allégé à 35 min.', state: 'pending' }],
      next: null,
    },
  },
};

const log: StrengthSession = {
  id: 4, date: '2026-10-08', name: 'Jambes', program: null, duration_min: 55, overall_rpe: 7, fatigue_level: null,
  sleep_quality: null, notes: null, total_volume: 4250, total_sets: 18, garmin_activity_id: 301, exercises: [],
};

/** The API the page reads, and every request it makes. */
async function mockApi(page: Page, theme: string) {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(`${route.request().method()} ${path}`);
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, theme, user_id: 1 } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, available: true } });
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'disconnected' } });
    if (path === '/api/analytics/sessions/12/detail') return route.fulfill({ json: run });
    if (path === '/api/analytics/sessions/301/detail') return route.fulfill({ json: strength });
    if (path === '/api/strength/sessions/4') return route.fulfill({ json: log });
    return route.fulfill({ json: [] });
  });
  return { requests, errors };
}

/** The session page's own reads: the app shell's (settings, notifications…) are not its business. */
const pageReads = (requests: string[]) =>
  requests.filter((r) => /\/api\/(analytics|strength|plan|planned|coach|tips|metrics|goals)\b/.test(r));

const SHOTS = '../.context/are140';

for (const theme of ['pierre', 'encre']) {
  for (const width of [390, 1440]) {
    test(`a run opens with its summary, coach and tomorrow in ${theme} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const { requests, errors } = await mockApi(page, theme);
      await page.goto('/log/sessions/12');
      const summary = page.getByRole('region', { name: 'L’essentiel de la séance' });
      await expect(summary).toBeVisible();
      await expect(summary).toContainText('10,20 km');
      await expect(summary).toContainText('4:50 /km');
      await expect(summary).toContainText('GAP 4:19 /km');
      await expect(summary).toContainText('152 bpm');
      await expect(summary).toContainText('Le mot du coach');
      await expect(summary).not.toContainText('Chiron');
      await expect(summary).toContainText('Footing bien dosé : le cardio est resté en endurance du début à la fin.');
      await expect(summary).not.toContainText('sortie longue de dimanche');
      await expect(summary).toContainText('Demain : Footing souple · 45 min · Z2.');
      await expect(summary.getByRole('region', { name: 'Effort ressenti' })).toBeVisible();
      // Above the fold: the numbers, the coach's sentence and tomorrow fit the first screen.
      const box = (await summary.getByText('Demain :').boundingBox())!;
      expect(box.y + box.height).toBeLessThan(844);
      // Summary, then the tiles, then the curves.
      const tilesTop = (await page.getByText('Calories', { exact: true }).boundingBox())!.y;
      const curvesTop = (await page.getByRole('heading', { name: 'Au fil de la séance' }).boundingBox())!.y;
      expect((await summary.boundingBox())!.y).toBeLessThan(tilesTop);
      expect(tilesTop).toBeLessThan(curvesTop);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${SHOTS}/run-${theme}-${width}.png` });
      // One read of the detail, nothing else: the summary has no request of its own.
      expect(pageReads(requests)).toEqual(['GET /api/analytics/sessions/12/detail']);
      expect(errors).toEqual([]);
    });

    test(`a strength session opens with tonnage, sets and its top 1RM in ${theme} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const { requests, errors } = await mockApi(page, theme);
      await page.goto('/log/sessions/301');
      const summary = page.getByRole('region', { name: 'L’essentiel de la séance' });
      await expect(summary).toBeVisible();
      await expect(summary).toContainText('Tonnage');
      await expect(summary).toContainText(/4\s250 kg/);
      await expect(summary).toContainText('18 séries');
      await expect(summary).toContainText('1RM estimé · Squat');
      await expect(summary).toContainText('+2,5 kg');
      await expect(summary).toContainText('120 kg · vs 1 oct.');
      await expect(summary).toContainText('Calculé à partir de la séance');
      await expect(summary).toContainText('Aujourd’hui : Fractionné · 50 min · Z4, le coach propose : allégée.');
      await expect(summary.getByRole('region', { name: 'Effort ressenti' })).toHaveCount(0);
      const box = (await summary.getByText('Aujourd’hui :').boundingBox())!;
      expect(box.y + box.height).toBeLessThan(844);
      expect((await summary.boundingBox())!.y).toBeLessThan((await page.getByText('Calories', { exact: true }).boundingBox())!.y);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${SHOTS}/strength-${theme}-${width}.png` });
      // The detail, and the linked log the exercises panel already read before the summary existed.
      expect(pageReads(requests).sort()).toEqual(['GET /api/analytics/sessions/301/detail', 'GET /api/strength/sessions/4']);
      expect(errors).toEqual([]);
    });
  }
}
