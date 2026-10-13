import { test, expect, type Page, type Route } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

const day = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const session = {
  id: 7, date: day(), sport: 'running', session_type: 'easy', source: 'coach', description: 'Footing du jour', status: 'pending',
  revision: 1, target_duration_min: 40, target_distance_km: null, target_hr_zone: 2, target_intensity: null, garmin_workout_id: null, garmin_pushed_at: null,
};
const stats = {
  level: 0, weeks_at_goal: 0,
  hp: { current: 50, max: 100, label: 'Récupération' }, mp: { current: 50, max: 100, label: 'Forme' }, xp: { current: 0, max: 300, label: 'Charge de la semaine' },
};

/** The dashboard's answers; `hold` keeps matching requests unanswered (a cold or unreachable server). */
async function dashboard(page: Page, hold: (path: string) => number | null = () => 0) {
  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    const delay = hold(path);
    if (delay === null) return; // never answered
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const json =
      path === '/api/settings' ? { ...DEFAULT_SETTINGS, user_id: 1, display_name: 'HUNTER' }
      : path === '/api/settings/gamification' ? { enabled: false, opted_in: false, available: true, version: 1 }
      : path === '/api/garmin/planned' ? [session]
      : path === '/api/plan/today' ? { decisions: [] }
      : path === '/api/metrics/player-stats' ? stats
      : path === '/api/goals/next' ? null
      : path === '/api/tips/daily' ? { tip: null }
      : path === '/api/coach/today' ? { date: day(), items: [], remaining: 0, briefing: null }
      : [];
    await route.fulfill({ json }).catch(() => {}); // the page may have moved on
  });
}

test('today’s session shows as soon as it arrives, whatever the slower panels', async ({ page }) => {
  await dashboard(page, path => (path === '/api/metrics/player-stats' ? 10_000 : 0));
  const planned = page.waitForResponse(r => new URL(r.url()).pathname === '/api/garmin/planned');
  await page.goto('/');
  await planned;
  await expect(page.getByText('Footing du jour')).toBeVisible({ timeout: 1_000 });
  await expect(page.getByRole('status', { name: 'Chargement des statistiques' })).toBeVisible();
});

test('a repeat visit paints the last known dashboard before any data answer', async ({ page }) => {
  await dashboard(page);
  await page.goto('/');
  await expect(page.getByText('Footing du jour')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bonjour, HUNTER' })).toBeVisible();
  // Writes are throttled to one a second.
  await page.waitForTimeout(1_500);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await dashboard(page, () => null);
  await page.reload();
  await expect(page.getByText('Footing du jour')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bonjour, HUNTER' })).toBeVisible();
});

test('hiding or leaving the page writes the pending cache at once', async ({ page }) => {
  await dashboard(page);
  await page.goto('/');
  await expect(page.getByText('Footing du jour')).toBeVisible();
  // Well under the one-second write delay: only the flush can have written it.
  const kept = await page.evaluate(`import('/src/lib/queryPersistence.ts').then(async ({ athletePersister }) => {
    const persister = athletePersister(3);
    persister.persistClient({ timestamp: Date.now(), buster: 'test', clientState: { queries: [], mutations: [] } });
    window.dispatchEvent(new Event('pagehide'));
    await new Promise(resolve => setTimeout(resolve, 200));
    return (await persister.restoreClient())?.buster ?? null;
  })`);
  expect(kept).toBe('test');
});

test.describe('signed-in build', () => {
  test.use({ baseURL: 'http://127.0.0.1:5180' });

  test('kept answers belong to one athlete and leave with the session', async ({ page }) => {
    // Clerk's script answers signed out: the gate then wipes what a previous session kept.
    await page.route('https://clerk.arete.test/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/clerk.browser.js')) return route.fulfill({ contentType: 'application/javascript', body: `
        window.Clerk = { loaded: false, client: { sessions: [], signedInSessions: [] }, session: null, user: null, organization: null,
          isSignedIn: false, frontendApi: 'clerk.arete.test', instanceType: 'development',
          __internal_lastEmittedResources: { client: { sessions: [], signedInSessions: [] }, session: null, user: null, organization: null },
          async load() { this.loaded = true; }, addListener(l) { l(this.__internal_lastEmittedResources); return () => {}; },
          mountSignIn(node) { node.innerHTML = '<p>Formulaire Clerk simulé</p>'; }, unmountSignIn() {} };` });
      if (path.endsWith('/ui.browser.js')) return route.fulfill({ contentType: 'application/javascript', body: 'window.__internal_ClerkUICtor = function ClerkUI() {};' });
      return route.fulfill({ status: 404, body: '' });
    });
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.goto('/');
    await expect(page.getByText('Formulaire Clerk simulé')).toBeVisible();
    // The dev server serves the module itself: the browser's real IndexedDB, keyed per athlete.
    const module = `import('/src/lib/queryPersistence.ts')`;
    const kept = () => page.evaluate(`${module}.then(({ athletePersister }) =>
      Promise.all([1, 2].map(async id => (await athletePersister(id).restoreClient())?.clientState ?? null)))`);
    await page.evaluate(`${module}.then(({ athletePersister }) => athletePersister(1).persistClient(
      { timestamp: Date.now(), buster: 'test', clientState: { queries: [], mutations: [] } }))`);
    await expect.poll(kept).toEqual([{ queries: [], mutations: [] }, null]);
    await page.reload();
    await expect(page.getByText('Formulaire Clerk simulé')).toBeVisible();
    await expect.poll(kept).toEqual([null, null]);
  });
});
