import { test, expect, type Route } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer } from './dashboardAnswer';

const player = {
  enabled: true, available: true, version: 3, athlete_class: 'sentinel', silhouette: 'balanced', equipped: 'base',
  xp: 1770, shards: 390, level: 6, rank: 'Adepte', in_level: 270, level_span: 600, sessions: 21, pending: 0,
  week: { sessions: 5, goal: 5, complete: true, timezone: 'Europe/Paris' },
  catalog: [], badges: [], history: [{ id: 'r1', cause: 'activity:a', week: '2026-10-12', xp: 50, shards: 10, label: 'Footing', created_at: '2026-10-13 07:00:00' }],
  has_more: false,
};

const synced = { ...player, xp: 1820, history: [{ ...player.history[0], id: 'r2', label: 'Séance sans montre' }] };

// Opening a page reads the progression; only a logged session projects it.
test('loading pages reads the RPG snapshot and logging a session syncs it once', async ({ page }) => {
  const syncs: string[] = [];
  const reads: string[] = [];
  await page.route('**/api/**', (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'fresh', complete: true } });
    if (path === '/api/gamification/sync') {
      syncs.push(path);
      return route.fulfill({ json: synced });
    }
    if (path === '/api/gamification') {
      reads.push(path);
      // The server's snapshot is the synced one once the session was projected.
      return route.fulfill({ json: syncs.length ? synced : player });
    }
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, display_name: 'HUNTER' } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: true, opted_in: true, available: true, version: 3 } });
    if (path === '/api/dashboard') return route.fulfill({ json: dashboardAnswer() });
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
  // The journal's summary shows the sync's answer: the cache holds it before the reload.
  await expect(page.getByText('Dernier reçu : Séance sans montre')).toBeVisible();
  await page.goto('/');
  await expect(page.getByText('Dernier reçu : Séance sans montre')).toBeVisible();
  expect(syncs).toHaveLength(1);
});
