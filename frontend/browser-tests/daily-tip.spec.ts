import { test, expect, type Route } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

const pending = { status: 'pending', tip: null, priority: null, source: null, generated_at: null, updated_after_sync: false };
const ready = { status: 'ready', tip: 'Footing facile de 40 minutes.', priority: 'info', source: 'agent', generated_at: '2026-10-13T07:00:00', updated_after_sync: true };

// The dashboard never waits on the coach: the read answers pending, the
// writing request runs on its own and a poll picks the briefing up.
test('a pending briefing is written in its own request and shown by the next poll', async ({ page }) => {
  const posts: string[] = [];
  let reads = 0;
  await page.route('**/api/**', (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST') {
      posts.push(path);
      if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'disconnected' } });
      if (path === '/api/tips/daily') return; // a long model run: never answered here
      return route.fulfill({ json: {} });
    }
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, display_name: 'HUNTER' } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, available: true } });
    if (path === '/api/coach/today') return route.fulfill({ json: { date: '2026-10-13', items: [], remaining: 0, briefing: null } });
    if (path === '/api/plan/today') return route.fulfill({ json: { decisions: [] } });
    if (path === '/api/metrics/player-stats') return route.fulfill({ json: {
      level: 0, weeks_at_goal: 0,
      hp: { current: 50, max: 100, label: 'Récupération', detail: '' },
      mp: { current: 50, max: 100, label: 'Forme' },
      xp: { current: 0, max: 300, label: 'Charge de la semaine', detail: '' },
    } });
    if (path === '/api/tips/daily') return route.fulfill({ json: reads++ === 0 ? pending : ready });
    return route.fulfill({ json: [] });
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Bonjour, HUNTER' })).toBeVisible();
  await expect(page.getByText('Le coach écrit ton briefing…')).toBeVisible();
  await expect(page.getByText('Footing facile de 40 minutes.')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Mis à jour après la synchro')).toBeVisible();
  await expect(page.getByText('Le coach écrit ton briefing…')).toHaveCount(0);
  expect(posts.sort()).toEqual(['/api/garmin/sync/ensure', '/api/tips/daily']);
});
