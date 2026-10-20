import { test, expect, type Page, type Route } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer, localDay } from './dashboardAnswer';

const session = {
  id: 7, date: localDay(), sport: 'running', session_type: 'easy', source: 'coach', description: 'Footing du jour', status: 'pending',
  revision: 1, target_duration_min: 40, target_distance_km: null, target_hr_zone: 2, target_intensity: null, garmin_workout_id: null, garmin_pushed_at: null,
};

/** The form curve's own request: lazy, after the dashboard, never in its first burst. */
const CURVE = 'GET /api/dashboard/form-curve';
const eager = (requests: string[]) => requests.filter(r => r !== CURVE);

/**
 * The dashboard's answers; `hold` keeps matching requests unanswered (a cold or
 * unreachable server) and `answer` replaces an answer when it returns one.
 * Every request but the auth configuration is recorded in `requests`.
 */
async function dashboard(
  page: Page,
  hold: (path: string) => number | null = () => 0,
  answer: (route: Route, path: string) => unknown = () => undefined,
  requests: string[] = [],
) {
  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    requests.push(`${route.request().method()} ${path}`);
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    const delay = hold(path);
    if (delay === null) return; // never answered
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const own = answer(route, path);
    if (own !== undefined) return route.fulfill({ json: own });
    const json =
      path === '/api/settings' ? { ...DEFAULT_SETTINGS, user_id: 1, display_name: 'HUNTER' }
      : path === '/api/onboarding' ? { status: 'completed', revision: 1 }
      : path === '/api/settings/gamification' ? { enabled: false, opted_in: false, available: true, version: 1 }
      : path === '/api/dashboard' ? dashboardAnswer({ planned: [session] })
      : path === '/api/coach/today' ? dashboardAnswer().coach
      : path === '/api/coach/attention' ? { enabled: false, mode: 'observation', items: [], remaining: 0, primary_ref: null }
      : path === '/api/garmin/sync/ensure' ? { state: 'fresh' }
      : [];
    await route.fulfill({ json }).catch(() => {}); // the page may have moved on
  });
  return requests;
}

test('the page frame shows at once, today’s session with the one answer, whatever the RPG', async ({ page }) => {
  // An opted-in athlete whose snapshot never answers, and a slow dashboard.
  await dashboard(
    page,
    path => (path === '/api/gamification' ? null : path === '/api/dashboard' ? 1_500 : 0),
    (_route, path) => (path === '/api/settings/gamification' ? { enabled: true, opted_in: true, available: true, version: 1 } : undefined),
  );
  const board = page.waitForResponse(r => new URL(r.url()).pathname === '/api/dashboard');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Bonjour, HUNTER' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Chargement de la séance du jour' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Chargement des statistiques' })).toBeVisible();
  await board;
  await expect(page.getByText('Footing du jour')).toBeVisible({ timeout: 1_000 });
  await expect(page.getByText('Prépare tes prochaines séances.')).toBeVisible();
  await expect(page.getByText('Chargement de la progression…')).toBeVisible();
});

test('the dashboard loads with seven reads and one freshness check, attention waits for the board', async ({ page }) => {
  // The worst case short of the RPG: Garmin connected and today's session still to send.
  const requests = await dashboard(page, () => 0, (route, path) => {
    if (path === '/api/dashboard') return dashboardAnswer({
      planned: [session], garmin_connected: true,
      health: { date: localDay(), readiness_score: 77, training_readiness_score: 64, hrv_last_night: 52, hrv_status: 'BALANCED' },
      next_goal: { id: 3, name: 'Semi de Lyon', race_date: localDay(40), distance_km: 21.1, target_time_sec: 5400, priority: 'A', status: 'active', days_left: 40, created_at: null },
      coach: { date: localDay(), items: [], remaining: 0, briefing: { text: 'Garde l’allure facile.', source: 'rules', trigger: 'api', created_at: null } },
    });
    if (path === '/api/garmin/workouts') {
      const view = { ...session, summary: '40 min Z2', exportable: true, derived: true, prescription: null };
      return { workouts: [{ session: view, export: null }], errors: {} };
    }
    return undefined;
  });
  await page.goto('/');
  await expect(page.getByText('Footing du jour')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Envoyer sur la montre' })).toBeVisible();
  await expect(page.getByText('77', { exact: true })).toBeVisible();
  await expect(page.getByText(/Semi de Lyon/)).toBeVisible();
  await expect(page.getByText('Prépare tes prochaines séances.')).toBeVisible();
  await page.waitForLoadState('networkidle');
  // The additional attention projection is bounded and starts after the board settles.
  expect(eager(requests).sort(), requests.join('\n')).toEqual([
    'GET /api/coach/attention', 'GET /api/dashboard', 'GET /api/garmin/workouts', 'GET /api/notifications', 'GET /api/onboarding', 'GET /api/settings', 'GET /api/settings/gamification',
    'POST /api/garmin/sync/ensure',
  ]);
  expect(requests.indexOf('GET /api/coach/attention')).toBeGreaterThan(requests.indexOf('GET /api/dashboard'));
  // The form curve is the page's one lazy read: once, after the dashboard answered.
  expect(requests.filter(r => r === CURVE)).toHaveLength(1);
  expect(requests.indexOf(CURVE)).toBeGreaterThan(requests.indexOf('GET /api/dashboard'));
});

test('today’s session goes to the watch through the export view and shows when', async ({ page }) => {
  const sentAt = '2026-10-09T05:07:00+00:00';
  const scheduled = { session_id: 7, operation_id: 'op', updated_at: '2026-10-09T05:07:00', state: 'scheduled', phase: 'scheduled', error: null, deleted: false, workout_id: 1, schedule_id: 100 };
  let sent = false;
  const reads: string[] = [];
  const sends: unknown[] = [];
  const legacy: string[] = [];
  let boards = 0;
  await dashboard(page, () => 0, (route, path) => {
    const url = new URL(route.request().url());
    if (/\/planned\/\d+\/(structure|push)$/.test(path)) legacy.push(path);
    if (path === '/api/dashboard') {
      boards++;
      return dashboardAnswer({ planned: [{ ...session, garmin_pushed_at: sent ? sentAt : null }], garmin_connected: true });
    }
    if (path === '/api/garmin/workouts') {
      reads.push(url.search);
      const view = { ...session, summary: '40 min Z2', exportable: true, derived: true, prescription: null };
      return { workouts: [{ session: view, export: sent ? scheduled : null }], errors: {} };
    }
    if (path === '/api/garmin/planned/7/export') {
      sends.push(route.request().postDataJSON());
      sent = true;
      return scheduled;
    }
    return undefined;
  });
  await page.goto('/');
  // One batched read of the export view; no per-session structure or push route.
  await page.getByRole('button', { name: 'Envoyer sur la montre' }).click();
  const clock = await page.evaluate(iso => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }), sentAt);
  // The push time comes from the dashboard read again after the session changed.
  await expect(page.getByText(`Envoyée à Garmin ${clock}`)).toBeVisible();
  expect(boards).toBeGreaterThanOrEqual(2);
  expect(sends).toEqual([{ device_id: null }]);
  expect(reads[0]).toBe('?ids=7');
  expect(legacy).toEqual([]);
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

test('a repeat visit and a focus refresh stay within the budget, the coach card read once', async ({ page }) => {
  await page.clock.install();
  const followup = { id: 1, session_id: 9, decision_id: null, question: 'Comment était la séance ?', requested_on: localDay(), expires_at: `${localDay(2)}T00:00:00`, state: 'pending', revision: 1, rpe: null, notes: null };
  const coach = { date: localDay(), items: [{ kind: 'followup', record: followup }], remaining: 0, briefing: null };
  await dashboard(page, () => 0, (_route, path) => (path === '/api/dashboard' ? dashboardAnswer({ planned: [session], coach }) : undefined));
  await page.goto('/');
  await expect(page.getByText('Comment était la séance ?')).toBeVisible();
  // Writes are throttled to one a second.
  await page.waitForTimeout(1_500);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const requests = await dashboard(page, () => 0, (_route, path) => (path === '/api/dashboard' ? dashboardAnswer({ planned: [session], coach }) : undefined));
  await page.reload();
  await expect(page.getByText('Footing du jour')).toBeVisible();
  await expect(page.getByText('Comment était la séance ?')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(eager(requests).sort(), requests.join('\n')).toEqual([
    'GET /api/coach/attention', 'GET /api/dashboard', 'GET /api/notifications', 'GET /api/onboarding', 'GET /api/settings', 'GET /api/settings/gamification', 'POST /api/garmin/sync/ensure',
  ]);
  expect(requests.filter(r => r === CURVE).length).toBeLessThanOrEqual(1);

  // Past the 30 s freshness, the athlete comes back to the tab.
  requests.length = 0;
  // The reload already reached `networkidle`, which would not wait again. The coach
  // card reads once the board has answered: its answer closes the refresh.
  const attention = page.waitForResponse(r => new URL(r.url()).pathname === '/api/coach/attention', { timeout: 10_000 });
  await page.clock.fastForward('00:45');
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await attention;
  expect(requests, requests.join('\n')).toContain('GET /api/dashboard');
  expect(requests.filter(r => r.endsWith('/coach/today') || r.endsWith('/tips/daily') || r === CURVE), requests.join('\n')).toEqual([]);
  // Progress refreshes too: another device may have confirmed the athlete's profile.
  expect(requests.filter(r => r === 'GET /api/onboarding')).toHaveLength(1);
  expect(requests.filter(r => r === 'GET /api/coach/attention')).toHaveLength(1);
  expect(requests.length, requests.join('\n')).toBeLessThanOrEqual(6);
});

test('a dashboard that fails says so with a retry, and the coach card and briefing load on their own', async ({ page }) => {
  let failing = true;
  const reads: string[] = [];
  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/onboarding') return route.fulfill({ json: { status: 'completed', revision: 1 } });
    reads.push(path);
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'fresh' } });
    if (path === '/api/dashboard') return failing ? route.fulfill({ status: 500, body: 'boom' }) : route.fulfill({ json: dashboardAnswer({ planned: [session] }) });
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, display_name: 'HUNTER' } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, opted_in: false, available: true, version: 1 } });
    if (path === '/api/coach/today') return route.fulfill({ json: { date: localDay(), items: [], remaining: 0, briefing: null } });
    if (path === '/api/tips/daily') return route.fulfill({ json: { status: 'ready', tip: 'Footing facile ce matin.', priority: 'info', source: 'rules', generated_at: null, updated_after_sync: false } });
    return route.fulfill({ json: [] });
  });
  await page.goto('/');
  await expect(page.getByText('Séance du jour indisponible.')).toBeVisible();
  await expect(page.getByText('Récupération indisponible.')).toBeVisible();
  await expect(page.getByText('Statistiques indisponibles.')).toBeVisible();
  await expect(page.getByText('Repos — aucune séance prévue')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Connecter Garmin' })).toHaveCount(0);
  await expect(page.getByText('Footing facile ce matin.')).toBeVisible();
  expect(reads.filter(p => p === '/api/coach/today')).toHaveLength(1);
  expect(reads.filter(p => p === '/api/tips/daily')).toHaveLength(1);

  failing = false;
  await page.getByText('Séance du jour indisponible.').getByRole('button', { name: 'Réessayer' }).click();
  await expect(page.getByText('Footing du jour')).toBeVisible();
  await expect(page.getByText('Séance du jour indisponible.')).toHaveCount(0);
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
