import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { SHAPES } from '../src/components/muscle-map/paths';
import { detail, review } from './analysis-data';

const year = new Date().getFullYear();
const muscles = [...new Set(SHAPES.map((shape) => shape.muscle))].map((muscle, index) => ({
  muscle,
  label: `Zone ${index + 1}`,
  volume: 1000 + index * 100,
  sets: 6,
  level: index % 5,
  last_trained: `${year}-10-18`,
}));

async function fixture(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/settings')
      return route.fulfill({ json: { ...DEFAULT_SETTINGS, theme: 'pierre', user_id: 1 } });
    if (path === '/api/settings/gamification')
      return route.fulfill({ json: { enabled: false, available: true } });
    if (path === '/api/notifications')
      return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/garmin/sync/ensure')
      return route.fulfill({ json: { state: 'disconnected' } });
    if (path === '/api/year-review')
      return route.fulfill({
        json: review(Number(url.searchParams.get('year')), {
          years: [year, year - 1, year - 2],
          ...(Number(url.searchParams.get('year')) === year - 2
            ? { totals: { sessions: 0, duration_sec: 0, distance_m: 0, ascent_m: 0, tss: 0 } }
            : {}),
        }),
      });
    if (/\/analytics\/sessions\/\d+\/detail$/.test(path))
      return route.fulfill({
        json: {
          ...detail,
          session: path.includes('/13/')
            ? {
                ...detail.session,
                id: 13,
                sport: 'cycling',
                name: 'Sortie vélo',
                avg_watts: 210,
                avg_cadence: 85,
              }
            : detail.session,
          splits: [
            {
              n: 1,
              distance_m: 1000,
              duration_sec: 300,
              speed_mps: 3.33,
              pace_sec_km: 300,
              avg_hr: 140,
              ascent_m: 12,
              descent_m: 3,
            },
          ],
        },
      });
    if (path === '/api/strength/stats/muscles')
      return route.fulfill({ json: { muscles, days: 7 } });
    if (path === '/api/strength/exercises')
      return route.fulfill({
        json: [
          { id: 1, name: 'Squat', muscle_group: 'quadriceps' },
          { id: 2, name: 'Hip Thrust', muscle_group: 'glutes' },
        ],
      });
    if (/\/strength\/exercises\/\d+\/history$/.test(path))
      return route.fulfill({
        json: [3, 2, 1].map((index) => ({
          date: `${year}-10-0${index}`,
          best_e1rm: 80 + index * 5,
          working_sets: 3,
          total_volume: 1800,
        })),
      });
    if (path.endsWith('/prs'))
      return route.fulfill({
        json: {
          max_weight: 80,
          max_weight_reps: 8,
          max_weight_date: `${year}-10-03`,
          best_e1rm: null,
          rep_records: [],
        },
      });
    if (path.endsWith('/suggestion')) return route.fulfill({ json: { suggestion: null } });
    return route.fulfill({ json: [] });
  });
  return errors;
}

for (const width of [1440, 390]) {
  test(`annual metrics, year persistence and source activity at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors = await fixture(page);
    await page.goto(`/analytics/bilan?year=${year - 1}`);
    await expect(page.getByRole('heading', { name: `Bilan ${year - 1}` })).toBeVisible();
    await expect(page.locator('.recharts-wrapper')).toHaveCount(2);
    const metrics = page.getByRole('group', { name: 'Mesure' });
    for (const [label, id] of [
      ['Distance', 'distance'],
      ['Séances', 'sessions'],
      ['Force', 'strength'],
      ['Temps', 'duration'],
    ]) {
      await metrics.getByRole('button', { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`metric=${id}`));
      await expect(metrics.getByRole('button', { name: label, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }
    await page.getByLabel('Année').selectOption(String(year));
    await page.reload();
    await expect(page.getByLabel('Année')).toHaveValue(String(year));
    await expect(metrics.getByRole('button', { name: 'Temps', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `../.context/arete-year-${width}.png`, fullPage: true });
    await page.getByRole('link', { name: /Col ·/ }).first().click();
    await expect(page).toHaveURL(/\/log\/sessions\/1$/);
    await expect(page.getByRole('heading', { name: 'Fractionné 5×1000' })).toBeVisible();
    await page.goto(`/analytics/bilan?year=${year - 2}`);
    await expect(page.getByText(`AUCUNE SÉANCE EN ${year - 2}`)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test(`running and cycling curves, cursor, lap details and splits at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors = await fixture(page);
    for (const [id, label] of [
      [12, 'Allure (min/km)'],
      [13, 'Vitesse (km/h)'],
    ] as const) {
      await page.goto(`/log/sessions/${id}`);
      await expect(page.locator('figure').filter({ hasText: label })).toBeVisible();
      await expect(page.locator('.recharts-wrapper')).toHaveCount(3);
      await expect(page.getByRole('img', { name: /Tracé GPS/ })).toBeVisible();
      const chart = page.locator('.recharts-wrapper').first();
      // Center the plot above the mobile navigation and floating coach launcher.
      await chart.evaluate((element) =>
        element.scrollIntoView({ block: 'center', behavior: 'instant' }),
      );
      const bounds = (await chart.boundingBox())!;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await expect(page.locator('.recharts-tooltip-wrapper').first()).toBeVisible();
      await page.getByRole('button', { name: 'Détail du tour 2' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Tour 2' })).toBeVisible();
      await expect(dialog).toContainText('170 / 178 bpm');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Kilomètres · 1' }).click();
      await expect(page.getByRole('heading', { name: 'Kilomètres', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Tours · 3' }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `../.context/arete-session-${id}-${width}.png`,
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
  });

  test(`every muscle region and exercise progression stay operable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors = await fixture(page);
    await page.goto('/log');
    const zone = page.getByLabel('Zone musculaire');
    await expect(zone).toBeVisible();
    for (const muscle of muscles) {
      await zone.selectOption(muscle.muscle);
      await expect(
        page.locator('[aria-live="polite"]').filter({ hasText: muscle.label }),
      ).toContainText('6 séries');
    }
    const exercise = page.getByLabel('Exercice', { exact: true });
    await exercise.selectOption('1');
    await expect(page.locator('.recharts-wrapper')).toHaveCount(1);
    await expect(page).toHaveURL(/exercise=1/);
    await exercise.selectOption('2');
    await page.reload();
    await expect(exercise).toHaveValue('2');
    await expect(page.locator('.recharts-line-curve')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `../.context/arete-strength-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}
