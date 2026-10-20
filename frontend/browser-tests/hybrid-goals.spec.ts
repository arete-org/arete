import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { localDay } from './dashboardAnswer';

const hyrox = {
  id: 7,
  name: 'Hyrox Paris',
  race_date: localDay(70),
  distance_km: 8,
  target_time_sec: 4500,
  priority: 'A',
  status: 'active',
  days_left: 70,
  created_at: null,
  goal_type: 'hyrox',
  details: { division: 'pro', format: 'doubles', category: 'mixed', equipment: ['sled', 'wall_ball'], weeks: 12 },
};

const session = (day: number, kind: string, description: string, tags: string[]) => ({
  date: localDay(day),
  session_type: kind === 'heavy_lower' ? 'strength' : 'intervals',
  duration_min: 50,
  hr_zone: null,
  intensity: 'hard',
  description,
  distance_km: null,
  sport: kind === 'heavy_lower' ? 'strength' : 'running',
  tags,
  kind,
});

const preview = {
  goal: hyrox,
  inputs: {
    weekly_minutes_now: 150,
    sessions_per_week: 6,
    training_days: 5,
    rest_days: [0],
    vdot: 48.5,
    level: 'intermediate',
    deload: false,
    kept: [{ date: localDay(9), description: 'Seuil : 2×10’ au seuil, déplacé au jeudi' }],
  },
  summary: [
    'Semaine type (base) : mar. course clé + bas du corps (après) · mer. footing · jeu. circuit stations · ven. haut du corps · sam. course compromise · lun. et dim. repos',
    'Semaine type (affûtage) : mar. course clé · mer. footing · jeu. circuit stations · ven. haut du corps · sam. course compromise · lun. et dim. repos',
    'Semaine de course : mer. activation · ven. footing · sam. course · lun., mar. et jeu. repos',
  ],
  weeks: [
    {
      start: localDay(7),
      phase: 'base',
      minutes: 300,
      recovery: false,
      sessions: [
        session(8, 'key_run', 'Seuil : 2×10’ au seuil, récup 2’', ['hard', 'key_run', 'run']),
        session(8, 'heavy_lower', 'Force bas du corps : squat, soulevé de terre roumain, fentes (après la course clé)', ['hard', 'heavy_lower', 'strength']),
        session(9, 'key_run', 'Seuil : 2×10’ au seuil, déplacé au jeudi', ['hard', 'kept', 'key_run', 'run']),
      ],
      dropped: ['Séance « Footing » retirée : pas de jour libre sans enfreindre les règles d’enchaînement.'],
    },
  ],
};

async function stubApi(page: Page, created: unknown[], written: string[]) {
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
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, theme: 'pierre' } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, available: true } });
    if (path === '/api/goals' && request.method() === 'POST') {
      created.push(request.postDataJSON());
      goals.push(hyrox);
      return route.fulfill({ status: 201, json: hyrox });
    }
    if (path === '/api/goals') return route.fulfill({ json: goals });
    if (path === `/api/goals/${hyrox.id}/plan/preview`) return route.fulfill({ json: preview });
    if (path === `/api/goals/${hyrox.id}/plan` && request.method() === 'POST') {
      written.push(path);
      return route.fulfill({ json: { created: 52, replaced: 0, skipped_days: [], weeks: 10 } });
    }
    return route.fulfill({ json: [] });
  });
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

for (const width of [1440, 390]) {
  test(`create a Hyrox goal, preview its plan and write it at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const created: unknown[] = [];
    const written: string[] = [];
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubApi(page, created, written);
    await page.goto('/settings?tab=goals');

    await page.getByRole('button', { name: 'Ajouter un objectif', exact: true }).click();
    await page.getByRole('group', { name: 'Type d’objectif' }).getByRole('button', { name: 'Hyrox' }).click();
    await page.getByPlaceholder('Hyrox Paris').fill('Hyrox Paris');
    await page.getByLabel('Date du Hyrox').fill(hyrox.race_date);
    await page.getByRole('button', { name: 'Pro', exact: true }).click();
    const mixed = page.getByRole('button', { name: 'Mixte', exact: true });
    await expect(mixed).toBeDisabled();
    await page.getByRole('button', { name: 'Duo', exact: true }).click();
    await mixed.click();
    await page.getByRole('button', { name: 'Traîneau (poussée et tirage)', exact: true }).click();
    await page.getByRole('button', { name: 'Wall ball', exact: true }).click();
    await page.getByPlaceholder('1:15:00').fill('1:15:00');
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({ path: `../.context/hybrid-goal-form-${width}.png`, fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: 'Ajouter le Hyrox', exact: true }).click();

    await expect(page.getByText(/Hyrox Pro · Duo · Mixte · objectif 1:15:00/)).toBeVisible();
    expect(created).toEqual([
      {
        name: 'Hyrox Paris',
        race_date: hyrox.race_date,
        target_time_sec: 4500,
        priority: 'A',
        goal_type: 'hyrox',
        details: { division: 'pro', format: 'doubles', category: 'mixed', equipment: ['sled', 'wall_ball'] },
      },
    ]);

    await page.getByRole('button', { name: 'Générer le plan', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Plan vers Hyrox Paris' });
    await expect(dialog.getByText(/Niveau intermédiaire · 5 jours d’entraînement\/sem/)).toBeVisible();
    await expect(dialog.getByText(preview.summary[0])).toBeVisible();
    await expect(dialog.getByText(preview.summary[2])).toBeVisible();
    await expect(dialog.getByText('Séances que tu as modifiées : gardées')).toBeVisible();
    await expect(dialog.getByText('1 séance retirée')).toBeVisible();
    await dialog.locator('summary').first().click();
    await expect(dialog.getByText('Course clé', { exact: true }).first()).toBeVisible();
    await expect(dialog.getByText('Bas du corps', { exact: true })).toBeVisible();
    await expect(dialog.getByText(/Séance « Footing » retirée/)).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({ path: `../.context/hybrid-plan-preview-${width}.png`, animations: 'disabled' });

    await dialog.getByRole('button', { name: 'Écrire le plan' }).click();
    await expect(dialog.getByRole('status')).toContainText('52 séances écrites');
    expect(written).toEqual([`/api/goals/${hyrox.id}/plan`]);
    expect(errors).toEqual([]);
  });
}
