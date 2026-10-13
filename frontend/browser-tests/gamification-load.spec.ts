import { test, expect, type Route } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

const player = {
  enabled: true, available: true, version: 3, athlete_class: 'sentinel', silhouette: 'balanced', equipped: 'base',
  xp: 1770, shards: 390, level: 6, rank: 'Adepte', in_level: 270, level_span: 600, sessions: 21, pending: 0,
  week: { sessions: 5, goal: 5, complete: true, timezone: 'Europe/Paris' },
  catalog: [], badges: [], history: [{ id: 'r1', cause: 'activity:a', week: '2026-10-12', xp: 50, shards: 10, label: 'Footing', created_at: '2026-10-13 07:00:00' }],
  has_more: false,
};

// Opening a page reads the progression; only a logged session projects it.
test('loading pages reads the RPG snapshot and logging a session syncs it once', async ({ page }) => {
  const syncs: string[] = [];
  const reads: string[] = [];
  await page.route('**/api/**', (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/gamification/sync') {
      syncs.push(path);
      return route.fulfill({ json: { ...player, xp: 1820, history: [{ ...player.history[0], id: 'r2', label: 'Séance sans montre' }] } });
    }
    if (path === '/api/gamification') {
      reads.push(path);
      return route.fulfill({ json: player });
    }
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, display_name: 'HUNTER' } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: true, opted_in: true, available: true, version: 3 } });
    if (path === '/api/coach/today') return route.fulfill({ json: { date: '2026-10-13', items: [], remaining: 0, briefing: null } });
    if (path === '/api/plan/today') return route.fulfill({ json: { decisions: [] } });
    if (path === '/api/tips/daily') return route.fulfill({ json: { status: 'ready', tip: 'Repos actif.', priority: 'info', source: 'rules', generated_at: '2026-10-13T07:00:00', updated_after_sync: false } });
    if (path === '/api/metrics/player-stats') return route.fulfill({ json: {
      level: 0, weeks_at_goal: 0,
      hp: { current: 50, max: 100, label: 'Récupération', detail: '' },
      mp: { current: 50, max: 100, label: 'Forme' },
      xp: { current: 0, max: 300, label: 'Charge de la semaine', detail: '' },
    } });
    if (path === '/api/garmin/actual' && request.method() === 'POST') return route.fulfill({ json: { id: 41, date: '2026-10-13', sport: 'running', source: 'manual', duration_sec: 2700 } });
    if (path === '/api/tips/post-session') return route.fulfill({ json: { feedback: 'Bien.', highlights: [], source: 'rules' } });
    return route.fulfill({ json: [] });
  });

  await page.goto('/');
  await expect(page.getByText('Niveau 6 · Adepte')).toBeVisible();
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'Niveau 6 · Adepte' })).toBeVisible();
  expect(syncs).toEqual([]);
  expect(reads.length).toBeGreaterThanOrEqual(2);

  await page.goto('/log?tab=cardio');
  await page.getByRole('button', { name: 'SANS MONTRE' }).click();
  await page.getByRole('button', { name: 'ENREGISTRER' }).click();
  await expect(page.getByRole('button', { name: 'ENREGISTRER' })).toBeHidden();
  await expect.poll(() => syncs.length).toBe(1);
  await page.goto('/');
  await expect(page.getByText('Dernier reçu : Footing')).toBeVisible();
  expect(syncs).toHaveLength(1);
});
