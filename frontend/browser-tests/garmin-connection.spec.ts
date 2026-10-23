import { test, expect, type Page } from '@playwright/test';
import { THEMES } from '../src/lib/theme';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer } from './dashboardAnswer';

test('connect Garmin with MFA, sync and disconnect from Connections', async ({ page }) => {
  let connected = false;
  let imported = 0;
  const loginBodies: unknown[] = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path.endsWith('/garmin/sync/ensure')) return route.fulfill({ json: { state: 'complete', complete: true } });
    if (path.endsWith('/auth/config')) return route.fulfill({ json: { enabled: false } });
    if (path.endsWith('/settings/gamification')) return route.fulfill({ json: { available: false, opted_in: false } });
    if (path.endsWith('/garmin/sync/status')) return route.fulfill({ json: { garmin_authenticated: connected, user_email: connected ? 'athlete@garmin.test' : null, activities_synced: imported } });
    if (path.endsWith('/garmin/sync/login')) {
      const body = route.request().postDataJSON();
      loginBodies.push(body);
      connected = body.mfa_code === '123456';
      return route.fulfill({ json: { success: connected, needs_mfa: !connected } });
    }
    if (path.endsWith('/garmin/sync/activities/stream')) {
      expect(connected).toBe(true);
      imported++;
      return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'done', success: true, activities_synced: 1, activities_merged: 0, activities_matched: 0, activities_skipped: 0, errors: [], last_activity_date: null })}\n\n` });
    }
    if (path.endsWith('/garmin/sync/logout')) {
      connected = false;
      return route.fulfill({ json: { success: true } });
    }
    if (path.includes('/settings')) return route.fulfill({ json: { theme: 'odyssey' } });
    return route.fulfill({ json: [] });
  });
  await page.goto('/settings?tab=connections');
  await expect(page.getByRole('heading', { name: 'Services connectés' })).toBeVisible();
  // Strava is retired: its API agreement forbids its data in an AI application.
  await expect(page.getByText('Strava', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Connecter Garmin' }).click();
  await page.getByLabel('E-mail', { exact: true }).fill('athlete@garmin.test');
  await page.getByLabel('Mot de passe', { exact: true }).fill('test-only-password');
  await page.getByRole('button', { name: 'Connecter', exact: true }).click();
  await page.getByLabel('Code', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Vérifier', exact: true }).click();
  await expect(page.getByText('athlete@garmin.test', { exact: true })).toBeVisible();
  expect(loginBodies).toEqual([
    { email: 'athlete@garmin.test', password: 'test-only-password' },
    { email: '', password: '', mfa_code: '123456' },
  ]);
  await page.getByRole('button', { name: 'Synchroniser', exact: true }).click();
  await expect(page.getByText('1 importées · 0 fusionnées · 0 déjà présentes')).toBeVisible();
  await page.getByRole('heading', { name: 'Services connectés' }).locator('..').screenshot({ path: '../.context/garmin-connected.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Déconnecter Garmin' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '../.context/garmin-connected-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Déconnecter Garmin' }).click();
  await expect(page.getByRole('button', { name: 'Connecter Garmin' })).toBeVisible();
  await expect(page.getByText('Garmin déconnecté. Tes séances importées sont conservées.')).toBeVisible();
  expect(imported).toBe(1);
});

test('one live progress bar follows Garmin work in System, including partial failures', async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path.endsWith('/garmin/sync/ensure')) return route.fulfill({ json: { state: 'complete', complete: true } });
    if (path.endsWith('/auth/config')) return route.fulfill({ json: { enabled: false } });
    if (path.endsWith('/settings/gamification')) return route.fulfill({ json: { available: false, opted_in: false } });
    if (path.endsWith('/garmin/sync/status')) return route.fulfill({ json: { garmin_authenticated: true, user_email: 'EDMOND', activities_synced: 86, last_sync: '2026-10-10T14:06:31' } });
    if (path.endsWith('/garmin/health/status')) return route.fulfill({ json: { days_stored: 8, last_date: '2026-10-10' } });
    if (path.endsWith('/health')) return route.fulfill({ json: { status: 'ok', database: 'connected' } });
    if (path.includes('/settings')) return route.fulfill({ json: { theme: 'odyssey' } });
    return route.fulfill({ json: [] });
  });
  // A controlled response body verifies intermediate renders, not only the final JSON.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const state = window as typeof window & { syncController?: ReadableStreamDefaultController<Uint8Array>; syncRequests?: number };
    localStorage.setItem('arete.theme.v1', 'odyssey');
    window.fetch = async (input, init) => {
      if (String(input).endsWith('/garmin/sync/activities/stream')) {
        state.syncRequests = (state.syncRequests ?? 0) + 1;
        const stream = new ReadableStream<Uint8Array>({ start(controller) { state.syncController = controller; } });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return original(input, init);
    };
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/settings?tab=system');
  const launch = page.getByRole('button', { name: 'Synchroniser les activités' });
  await expect(launch).toHaveCount(1);
  await page.getByLabel('Période').selectOption('365');
  await page.getByLabel('Activités maximum').fill('200');
  await launch.click();
  await expect(page.getByRole('progressbar')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Synchronisation en cours' })).toBeDisabled();
  await expect(page.getByLabel('Période')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Se déconnecter de Garmin' })).toBeDisabled();
  const emit = (event: Record<string, unknown>) => page.evaluate(event => {
    const state = window as typeof window & { syncController: ReadableStreamDefaultController<Uint8Array> };
    state.syncController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  }, event);
  await emit({ type: 'progress', stage: 'fetching', completed: 0, total: null, activity_name: null });
  // The app keeps an empty live region for the Garmin freshness outcome: name the sync's.
  await expect(page.getByRole('status').filter({ hasText: 'Récupération des activités Garmin' })).toBeVisible();
  await emit({ type: 'progress', stage: 'fit', completed: 12, total: 24, activity_name: 'Sortie longue · 18 km' });
  await expect(page.getByText('12 / 24 activités traitées')).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '52');
  const panel = page.getByText('Synchronisation Garmin', { exact: true }).locator('..');
  await panel.screenshot({ path: '../.context/garmin-sync-progress.png' });
  await page.setViewportSize({ width: 390, height: 1100 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await panel.screenshot({ path: '../.context/garmin-sync-progress-mobile.png' });
  await emit({ type: 'progress', stage: 'finalizing', completed: 0, total: null, activity_name: null });
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '95');
  await emit({ type: 'done', success: true, activities_synced: 20, activities_merged: 1, activities_matched: 0, activities_skipped: 3, errors: ['Un fichier FIT indisponible'], last_activity_date: null });
  await expect(page.getByRole('status').filter({ hasText: 'terminée avec des erreurs' })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  await page.getByText('1 erreur(s) à consulter').click();
  await expect(page.getByText('Un fichier FIT indisponible')).toBeVisible();
  await expect(launch).toBeEnabled();
  expect(await page.evaluate(() => (window as typeof window & { syncRequests: number }).syncRequests)).toBe(1);
});

test('complete history runs multiple batches from one click with mobile progress', async ({ page }) => {
  const requests: Record<string, unknown>[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path.endsWith('/garmin/sync/ensure')) return route.fulfill({ json: { state: 'complete', complete: true } });
    if (path.endsWith('/auth/config')) return route.fulfill({ json: { enabled: false } });
    if (path.endsWith('/settings/gamification')) return route.fulfill({ json: { available: false, opted_in: false } });
    if (path.endsWith('/garmin/sync/status')) return route.fulfill({ json: { garmin_authenticated: true, user_email: 'EDMOND', activities_synced: 1001 } });
    if (path.endsWith('/garmin/health/status')) return route.fulfill({ json: { days_stored: 10, last_date: '2026-10-12' } });
    if (path.endsWith('/health')) return route.fulfill({ json: { status: 'ok', database: 'connected' } });
    if (path.includes('/settings')) return route.fulfill({ json: { theme: 'odyssey' } });
    if (path.endsWith('/garmin/sync/activities/stream')) {
      const request = route.request().postDataJSON();
      requests.push(request);
      const first = requests.length === 1;
      if (!first) await gate;
      const events = [
        { type: 'progress', stage: 'processing', completed: first ? 20 : 1, total: first ? 20 : 1, activity_name: null },
        { type: 'done', success: true, activities_synced: first ? 0 : 1, activities_merged: 0, activities_matched: 0, activities_skipped: first ? 20 : 0, errors: [], last_activity_date: null, next_history_offset: first ? 20 : null, history_anchor: first ? 123 : null },
      ];
      return route.fulfill({ contentType: 'text/event-stream', body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') });
    }
    return route.fulfill({ json: [] });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/settings?tab=system');
  await page.getByLabel('Période').selectOption('all');
  await expect(page.getByLabel('Activités maximum')).toHaveCount(0);
  const launch = page.getByRole('button', { name: 'Synchroniser les activités' });
  await expect(launch).toHaveAttribute('data-strong', 'true');
  await page.getByRole('button', { name: 'Synchroniser les activités' }).click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(page.getByText('20 activités traitées · historique complet')).toBeVisible();
  await expect(page.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  await expect(page.getByLabel('Période')).toBeDisabled();
  await expect(page.getByLabel('Télécharger les fichiers FIT')).toBeDisabled();
  const form = page.locator('form').filter({ has: page.getByLabel('Période') });
  const progressPanel = page.getByRole('progressbar').locator('..');
  // The same controls and nested surfaces must follow every theme's tokens.
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    for (const theme of THEMES) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme.value);
      await expect(page.getByLabel('Période')).toHaveCSS('font-family', /Inter/);
      await expect(page.getByLabel('Période')).toHaveCSS('border-radius', '9px');
      await expect(form).toHaveCSS('border-radius', '9px');
      await expect(progressPanel).toHaveCSS('border-radius', '9px');
      const surface = await form.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderColor }));
      expect(surface.background).not.toContain('rgba');
      await expect(progressPanel).toHaveCSS('background-color', surface.background);
      await expect(progressPanel).toHaveCSS('border-color', surface.border);
      await expect(page.getByLabel('Période')).toHaveCSS('border-color', surface.border);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      if (theme.value === 'pierre' || theme.value === 'encre') {
        await page.getByText('Synchronisation Garmin', { exact: true }).locator('..').screenshot({ path: `../.context/garmin-history-${theme.value}-${width}.png` });
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 1100 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByText('Synchronisation Garmin', { exact: true }).locator('..').screenshot({ path: '../.context/garmin-full-history-mobile.png' });
  release();
  await expect(page.getByText('1 importées · 0 fusionnées · 20 déjà présentes')).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  await expect(page.getByRole('button', { name: 'Synchroniser les activités' })).toBeEnabled();
  expect(requests).toEqual([
    { download_fit: true, max_activities: 20, history_offset: 0 },
    { download_fit: true, max_activities: 20, history_offset: 20, history_anchor: 123 },
  ]);
});

test('opening the app refreshes Garmin once and reports a partial result', async ({ page }) => {
  let imports = 0;
  let release!: () => void;
  const completed = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path.endsWith('/auth/config')) return route.fulfill({ json: { enabled: false } });
    if (path.endsWith('/settings/gamification')) return route.fulfill({ json: { available: false, opted_in: false } });
    if (path.endsWith('/garmin/sync/ensure')) {
      imports++;
      expect(route.request().method()).toBe('POST');
      await completed;
      return route.fulfill({ json: { state: 'partial', complete: false, session_ids: [42] } });
    }
    if (path.endsWith('/garmin/sync/status')) return route.fulfill({ json: { garmin_authenticated: true, activities_synced: 1 } });
    if (path.includes('/settings')) return route.fulfill({ json: { theme: 'odyssey' } });
    return route.fulfill({ json: [] });
  });
  await page.goto('/settings?tab=connections');
  await expect(page.getByText('Vérification Garmin…')).toBeVisible();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(imports).toBe(1);
  release();
  await expect(page.getByText('Garmin : synchronisation incomplète. Les données enregistrées restent disponibles.')).toBeVisible();
});

/** Pierre at phone width, every API answered here; screenshots go to ../.context/garmin-catch-up/. */
async function capped(page: Page, ensure: Record<string, unknown>) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    localStorage.setItem('arete.install.dismissed', '1');
    localStorage.setItem('arete.notifications.offered', '1');
  });
  let imported = 0;
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, theme: 'pierre', user_id: 1 } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/dashboard') return route.fulfill({ json: dashboardAnswer() });
    if (path === '/api/onboarding') return route.fulfill({ json: { revision: 0, status: 'not_started' } });
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: ensure });
    if (path === '/api/garmin/sync/status') return route.fulfill({ json: { garmin_authenticated: true, activities_synced: imported, last_sync: null, user_email: null } });
    if (path === '/api/garmin/sync/activities/stream') {
      imported = 20;
      // The first batch reached the 20-activity cap; the rest is not a failure.
      return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'done', success: true, activities_synced: 20, activities_merged: 0, activities_matched: 0, activities_skipped: 0, errors: [], last_activity_date: '2026-10-21', more_pending: true })}\n\n` });
    }
    return route.fulfill({ json: [] });
  });
}

test('onboarding shows a capped first import as catching up, not interrupted', async ({ page }) => {
  await capped(page, { state: 'disconnected' });
  await page.addInitScript(() => {
    localStorage.setItem('arete.onboarding.v1.athlete.1', JSON.stringify({ version: 1, step: 3, deferred: false, command_id: 'capped-import', answers: { display_name: 'Camille', goal: 'progress', description: null, race_name: null, race_date: null, sports: ['running'], weekly_training_goal: 3, rest_day_preference: null, constraints: null, timezone: null } }));
  });
  await page.goto('/onboarding');
  await page.getByRole('button', { name: 'Importer mes activités récentes' }).click();
  await expect(page.getByText('20 activités importées, la suite arrive automatiquement')).toBeVisible();
  await expect(page.getByText(/Import interrompu/)).toHaveCount(0);
  await expect(page.getByText('Synchronisation terminée', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.onboarding-data-status').evaluate(node => node.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: '../.context/garmin-catch-up/onboarding-pierre-390.png' });
});

test('the app banner tells a capped refresh apart from a failed one', async ({ page }) => {
  await capped(page, { state: 'partial', complete: false, more_pending: true, errors: [] });
  await page.goto('/');
  await expect(page.getByText('Import Garmin en cours de rattrapage. La suite arrive automatiquement.')).toBeVisible();
  await expect(page.getByText(/synchronisation incomplète/)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '../.context/garmin-catch-up/dashboard-pierre-390.png' });
});
