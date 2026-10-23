import { test, expect, type Page, type Route } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer, localDay } from './dashboardAnswer';

const goal = {
  id: 3, name: 'Semi de Lyon', race_date: localDay(40), distance_km: 21.1, target_time_sec: 5400,
  priority: 'A', status: 'active', days_left: 40, created_at: null,
};
/** Twelve weeks of history then, with a race, its projection: the curve's answer. */
function curve(withGoal: boolean) {
  const series = [];
  for (let i = -84; i <= (withGoal ? 40 : 0); i++)
    series.push({ date: localDay(i), ctl: 40 + i / 10, atl: 38 + Math.sin(i / 3) * 6, tsb: 2 - Math.sin(i / 3) * 6, planned: i > 0 });
  // Today's point is the dashboard's form (`fitness` below): the projection starts after it.
  return {
    today: localDay(), goal_id: withGoal ? 3 : null, series, planned_sessions: withGoal ? 24 : 0,
    last_planned: withGoal ? localDay(39) : null,
    race_day: withGoal ? { ctl: 44, tsb: 8.4 } : null,
    key_session: withGoal ? { id: 9, date: localDay(2), session_type: 'intervals', description: '6 x 1000 m', target_duration_min: 60 } : null,
  };
}

/** The dashboard's form today, which the curve's today point repeats. */
const fitness = {
  ctl: 40, atl: 38, tsb: 2, form_zone: 'neutral', readiness_score: 60, readiness_level: 'good',
  readiness_source: 'model', readiness_measured_on: null, ramp_rate: null, days_analyzed: 40,
};

async function fixture(page: Page, withGoal: boolean, requests: string[]) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('arete.install.dismissed', '1');
    localStorage.setItem('arete.notifications.offered', '1');
  });
  await page.route('**/api/**', (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    requests.push(path);
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, display_name: 'HUNTER' } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, available: true } });
    if (path === '/api/dashboard') return route.fulfill({ json: dashboardAnswer({ next_goal: withGoal ? goal : null, fitness, has_load: true }) });
    if (path === '/api/dashboard/form-curve') return route.fulfill({ json: curve(withGoal) });
    return route.fulfill({ json: [] });
  });
}

test('with a race, the goal card leads and the curve projects to race day in plain words', async ({ page }) => {
  const requests: string[] = [];
  await fixture(page, true, requests);
  await page.goto('/');
  expect(requests).not.toContain('/api/dashboard/form-curve');
  const goal = page.getByRole('link', { name: /Semi de Lyon/ });
  await page.getByRole('button', { name: 'Détails de ma forme' }).click();
  const card = page.getByRole('region', { name: 'Objectif de course' });
  await expect(card.getByText('Semi de Lyon')).toBeVisible();
  await expect(card.getByText('J-40')).toBeVisible();
  await expect(card.getByText('entre +3 et +13')).toBeVisible();
  await expect(card.getByRole('link', { name: /Séance clé : .* Fractionné · 60 min/ })).toHaveAttribute('href', `/planning?date=${localDay(2)}`);
  // On a phone: the greeting, then the race, then the briefing.
  const greeting = (await page.getByRole('heading', { name: 'Bonjour, HUNTER' }).boundingBox())!;
  const race = (await goal.boundingBox())!;
  const briefing = (await page.getByRole('heading', { name: 'Briefing du jour' }).boundingBox())!;
  expect(greeting.y).toBeLessThan(race.y);
  expect(race.y).toBeLessThan(briefing.y);

  const panel = page.locator('figure');
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.locator('.recharts-surface')).toBeVisible();
  await expect(panel.locator('figcaption')).toContainText('Aujourd’hui : fatigue 38, fraîcheur +2.');
  await expect(panel.locator('figcaption')).toContainText('Projection le jour J : forme de fond 44, fraîcheur entre +3 et +13.');
  // The card says the same form as the dashboard's "Fraîcheur" card.
  await expect(page.getByText('+2,0', { exact: true })).toBeVisible();
  await expect(page.getByText('Pointillés : projection')).toBeVisible();
  // The goal card and the curve share one lazy read, after the dashboard's.
  expect(requests.filter(p => p === '/api/dashboard/form-curve')).toHaveLength(1);
  expect(requests.indexOf('/api/dashboard/form-curve')).toBeGreaterThan(requests.indexOf('/api/dashboard'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('without a race, a compact call to set one, and the curve read only once on screen', async ({ page }) => {
  const requests: string[] = [];
  await fixture(page, false, requests);
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Fixer un objectif' })).toHaveAttribute('href', '/planning/objectifs');
  await expect(page.getByText('Prépare tes prochaines séances.')).toBeVisible();
  await page.waitForLoadState('networkidle');
  // Below the fold on a phone: nothing read yet.
  expect(requests).not.toContain('/api/dashboard/form-curve');
  await page.getByRole('button', { name: 'Détails de ma forme' }).click();
  await page.getByRole('heading', { name: 'Courbe de forme' }).scrollIntoViewIfNeeded();
  await expect(page.locator('figcaption')).toContainText('Sur 12 semaines, ta forme de fond est passée de 32 à 40.');
  expect(requests.filter(p => p === '/api/dashboard/form-curve')).toHaveLength(1);
});
