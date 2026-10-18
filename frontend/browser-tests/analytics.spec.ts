import { expect, test } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

const headline = (display: string) => ({
  display,
  value: 50,
  unit: '',
  previous: 45,
  delta: 5,
  delta_pct: 11,
  better: 'neutral',
});
const names = [
  'volume',
  'pmc',
  'zones',
  'sports',
  'decoupling',
  'pace',
  'elevation',
  'cadence',
  'vam',
  'descent',
  'readiness',
  'hrv',
  'sleep',
  'resting_hr',
];
function overview(period: string) {
  const cards = Object.fromEntries(
    names.map((name) => [
      name,
      {
        headline: headline(
          name === 'volume'
            ? period === '7d'
              ? '42 km'
              : '128 km'
            : name === 'sleep'
              ? '7 h 30'
              : '50',
        ),
        secondary: [],
        insight: { text: 'Mesures enregistrées sur cette période.', tone: 'neutral' },
        series: Array.from({ length: 7 }, (_, index) => ({
          bucket: `2026-10-${String(12 + index).padStart(2, '0')}`,
          run_km: 7,
          km: 8,
          hours: 1,
          ctl: 40 + index,
          atl: 48 + index,
          tsb: -8,
          tss: 52,
          z1: 10,
          z2: 29,
          z3: 5,
          z4: 4,
          z5: 2,
          z1_pct: 20,
          z2_pct: 58,
          z3_pct: 10,
          z4_pct: 8,
          z5_pct: 4,
          decoupling_pct: 3 + index * 0.1,
          efficiency: 13.1,
          pace_sec_km: 340 - index,
          n_runs: 1,
          n_graded: 0,
          run_m: 220,
          walk_m: 40,
          m_per_km: 22,
          cadence: 170 + index,
          stride_m: 1.06,
          value: index === 3 ? null : name === 'sleep' ? 27000 : 60 + index,
        })),
      },
    ]),
  );
  Object.assign(cards.sports, {
    series: [
      { sport: 'running', hours: 9, pct: 75, count: 12 },
      { sport: 'cycling', hours: 3, pct: 25, count: 3 },
    ],
  });
  Object.assign(cards.vam, {
    series: [5, 10, 20, 30, 60].map((minutes) => ({
      minutes,
      period: 850,
      record: 950,
      period_date: '2026-10-15',
      record_date: '2026-05-01',
    })),
  });
  Object.assign(cards.descent, { series: [{ min: -5, max: -2, pace_sec_km: 300, minutes: 34 }] });
  return {
    period,
    bucket: 'day',
    start: '2026-10-12',
    end: '2026-10-18',
    prev_start: '2026-10-05',
    prev_end: '2026-10-11',
    cards,
    hr_zone_model: { basis: 'lthr', reference: 172, boundaries: [146, 153, 163, 172], ranges: [] },
  };
}

for (const width of [1440, 390]) {
  test(`all analytics charts, six periods and missing sleep samples at ${width}px`, async ({
    page,
  }) => {
    const errors: string[] = [];
    const periods: string[] = [];
    const writes: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/api/**', (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (route.request().method() !== 'GET' && path !== '/api/garmin/sync/ensure')
        writes.push(path);
      if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
      if (path === '/api/settings')
        return route.fulfill({ json: { ...DEFAULT_SETTINGS, theme: 'pierre', user_id: 1 } });
      if (path === '/api/settings/gamification')
        return route.fulfill({ json: { enabled: false, available: true } });
      if (path === '/api/notifications')
        return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
      if (path === '/api/garmin/sync/ensure')
        return route.fulfill({ json: { state: 'disconnected' } });
      if (path === '/api/analytics/overview') {
        const period = url.searchParams.get('period') ?? '30d';
        periods.push(period);
        return route.fulfill({ json: overview(period) });
      }
      if (path === '/api/analytics/records') return route.fulfill({ json: { records: [] } });
      return route.fulfill({ json: [] });
    });
    await page.goto('/analytics?period=7d');
    await expect(page.getByText('42 km', { exact: true })).toBeVisible();
    await expect(page.locator('.analysis-card')).toHaveCount(15);
    await expect(page.locator('.recharts-wrapper')).toHaveCount(13);
    const selector = page.getByRole('group', { name: 'Période analysée' });
    for (const [label, value] of [
      ['30 J', '30d'],
      ['90 J', '90d'],
      ['6 M', '6m'],
      ['1 AN', '1y'],
      ['TOUT', 'all'],
      ['7 J', '7d'],
    ]) {
      await selector.getByRole('button', { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`period=${value}`));
      await expect(selector.getByRole('button', { name: label, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }
    expect(new Set(periods)).toEqual(new Set(['7d', '30d', '90d', '6m', '1y', 'all']));
    await page.reload();
    await expect(selector.getByRole('button', { name: '7 J', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const sleep = page
      .locator('.analysis-card')
      .filter({ has: page.getByRole('heading', { name: 'Sommeil', exact: true }) });
    await sleep.scrollIntoViewIfNeeded();
    await expect(sleep).toContainText('7 h 30');
    const path = await sleep.locator('.recharts-area-curve').getAttribute('d');
    expect((path?.match(/M/g) ?? []).length).toBe(2); // A real gap, not a line across the absent sample.
    await page
      .getByRole('navigation', { name: 'Sections des analyses' })
      .getByRole('button', { name: 'Charge', exact: true })
      .click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `../.context/arete-analytics-${width}.png`,
      animations: 'disabled',
    });
    expect(errors).toEqual([]);
    expect(writes).toEqual([]);
  });
}
