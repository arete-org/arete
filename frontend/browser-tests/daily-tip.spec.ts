import { test, expect, type Route } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer } from './dashboardAnswer';

const pending = { status: 'pending', tip: null, priority: null, source: null, generated_at: null, updated_after_sync: false };
const ready = { status: 'ready', tip: 'Footing facile de 40 minutes.', priority: 'info', source: 'agent', generated_at: '2026-10-13T07:00:00', updated_after_sync: true };

// The dashboard never waits on the coach: its read answers pending, the
// writing request runs on its own and a poll picks the briefing up.
test('a pending briefing is written in its own request and shown by the next poll', async ({ page }) => {
  const posts: string[] = [];
  const reads: string[] = [];
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
    if (path === '/api/dashboard') return route.fulfill({ json: dashboardAnswer({ briefing: pending }) });
    if (path === '/api/tips/daily') {
      reads.push(path);
      return route.fulfill({ json: ready });
    }
    return route.fulfill({ json: [] });
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Bonjour, HUNTER' })).toBeVisible();
  await expect(page.getByText('Le coach écrit ton briefing…')).toBeVisible();
  await expect(page.getByText('Footing facile de 40 minutes.')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Mis à jour après la synchro')).toBeVisible();
  await expect(page.getByText('Le coach écrit ton briefing…')).toHaveCount(0);
  expect(posts.sort()).toEqual(['/api/garmin/sync/ensure', '/api/tips/daily']);
  // The first read was the dashboard's: only the poll read the briefing again.
  expect(reads).toEqual(['/api/tips/daily']);
});
