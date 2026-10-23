import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { localDay } from './dashboardAnswer';

const triathlon = {
  id: 9,
  name: 'Triathlon de Nice',
  race_date: localDay(110),
  distance_km: 113,
  target_time_sec: null,
  priority: 'A',
  status: 'active',
  days_left: 110,
  created_at: null,
  goal_type: 'triathlon',
  details: { distance: 'half', hours_per_week: 10, pool_length_m: 50 },
};

const session = (day: number, kind: string, sport: string, description: string, tags: string[]) => ({
  date: localDay(day),
  session_type: 'tempo',
  duration_min: 60,
  hr_zone: 'Z3',
  intensity: 'hard',
  description,
  distance_km: null,
  sport,
  tags,
  kind,
});

const preview = {
  goal: triathlon,
  inputs: {
    weekly_minutes_now: 420,
    sessions_per_week: 8,
    training_days: 6,
    rest_days: [0],
    vdot: 47,
    level: 'intermediate',
    deload: false,
    kept: [],
    hours_per_week: 10,
    peak_minutes: 600,
    split: { swimming: 0.15, cycling: 0.5, running: 0.35 },
    ftp_w: null,
    css_sec_100m: 100,
    hr_reference: true,
  },
  summary: [
    'Semaine type (développement) : mar. vélo clé + course enchaînée · mer. natation clé + vélo facile · jeu. sortie longue · sam. sortie longue vélo · dim. course clé · lun. repos',
    'Semaine de course : jeu. activation · ven. activation · sam. activation · dim. triathlon · lun. repos',
  ],
  weeks: [
    {
      start: localDay(7),
      phase: 'build',
      minutes: 540,
      recovery: false,
      sessions: [
        session(8, 'brick_bike', 'cycling', 'Vélo sweet spot : 3×12’ à zone 3 FC, puis enchaînement course à pied', ['bike', 'bike_key', 'brick_bike', 'hard']),
        session(8, 'brick_run', 'running', 'Course en enchaînement, juste après le vélo : 15’ facile', ['brick_run', 'run']),
        session(9, 'swim_key', 'swimming', 'Natation seuil (1 900 m) : 300 m souple + 10×100 m allure CSS (1:40/100 m)', ['swim', 'swim_key']),
      ],
      dropped: [],
    },
  ],
};

async function stubApi(page: Page, created: unknown[], saved: unknown[]) {
  const goals: unknown[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('arete.install.dismissed', '1');
    localStorage.setItem('arete.notifications.offered', '1');
  });
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/settings' && request.method() === 'PUT') {
      saved.push(request.postDataJSON());
      return route.fulfill({ json: { ...request.postDataJSON(), user_id: 1 } });
    }
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, theme: 'pierre' } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, available: true } });
    if (path === '/api/goals' && request.method() === 'POST') {
      created.push(request.postDataJSON());
      goals.push(triathlon);
      return route.fulfill({ status: 201, json: triathlon });
    }
    if (path === '/api/goals') return route.fulfill({ json: goals });
    if (path === `/api/goals/${triathlon.id}/plan/preview`) return route.fulfill({ json: preview });
    return route.fulfill({ json: [] });
  });
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

for (const width of [1440, 390]) {
  test(`create a triathlon, preview its plan and set FTP and CSS at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const created: unknown[] = [];
    const saved: unknown[] = [];
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubApi(page, created, saved);
    await page.goto('/settings?tab=goals');

    await page.getByRole('button', { name: 'Ajouter un objectif', exact: true }).click();
    await page.getByRole('group', { name: 'Type d’objectif' }).getByRole('button', { name: 'Triathlon' }).click();
    await page.getByPlaceholder('Triathlon de Paris').fill('Triathlon de Nice');
    await page.getByLabel('Date du triathlon').fill(triathlon.race_date);
    await page.getByRole('group', { name: 'Format' }).getByRole('button', { name: '70.3' }).click();
    await expect(page.getByText('Natation · vélo · course à pied : 1,9 km · 90 km · 21,1 km')).toBeVisible();
    await page.getByPlaceholder('8', { exact: true }).fill('10');
    await page.getByRole('button', { name: '50 m', exact: true }).click();
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({ path: `../.context/triathlon-goal-form-${width}.png`, fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: 'Ajouter le triathlon', exact: true }).click();

    await expect(page.getByText(/Triathlon 70\.3 · 10 h\/sem/)).toBeVisible();
    expect(created).toEqual([
      {
        name: 'Triathlon de Nice',
        race_date: triathlon.race_date,
        target_time_sec: null,
        priority: 'A',
        goal_type: 'triathlon',
        details: { distance: 'half', hours_per_week: 10, pool_length_m: 50 },
      },
    ]);

    await page.getByRole('button', { name: 'Générer le plan', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Plan vers Triathlon de Nice' });
    await expect(dialog.getByText(/Répartition : natation 15 % · vélo 50 % · course à pied 35 %/)).toBeVisible();
    await expect(dialog.getByText('Sans FTP : vélo à la fréquence cardiaque · CSS 1:40/100 m')).toBeVisible();
    await expect(dialog.getByText(preview.summary[0])).toBeVisible();
    await dialog.locator('summary').first().click();
    await expect(dialog.getByText('Course enchaînée', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Natation clé', { exact: true })).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({ path: `../.context/triathlon-plan-preview-${width}.png`, animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Fermer' }).click();

    await page.getByPlaceholder('230').fill('245');
    const css = page.getByPlaceholder('1:45');
    await css.fill('1:38');
    await css.blur();
    expect(await noOverflow(page)).toBe(true);
    expect(errors).toEqual([]);
  });
}
