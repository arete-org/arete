import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import type { WorkoutView } from '../src/lib/workouts';

const session = { id: 42, revision: 1, date: '2027-01-12', sport: 'running', session_type: 'intervals', source: 'coach', description: 'Fractionné · 6 × 400 m', status: 'pending', summary: '15 min Z2 · 6 × (400 m / récupération 90 s) · 10 min faciles', exportable: true, derived: false, prescription: { version: 1 as const, steps: [{ kind: 'effort' as const, duration_kind: 'meters' as const, value: 400, steps: [] }] }, target_duration_min: null, target_distance_km: null, target_hr_zone: null, target_intensity: null, garmin_workout_id: null, garmin_pushed_at: null };
const state = (status: string) => ({ session_id: 42, operation_id: 'op-42', updated_at: new Date().toISOString(), state: status, phase: status === 'working' ? 'creating' : 'scheduled', error: null, deleted: false, workout_id: 7, schedule_id: 9 });
async function mockApi(page: Page, getView: () => WorkoutView, streamUrl?: string) {
  if (streamUrl) await page.addInitScript(url => {
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => fetch(input === '/api/agent/chat/stream' ? url : input, init);
  }, streamUrl);
  const counts = { exports: 0, model: 0, devices: 0, edits: 0 };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.endsWith('/chat/stream')) {
      counts.model++;
      return route.fulfill({ status: 307, headers: { location: streamUrl! } });
    }
    if (url.pathname.endsWith('/workout')) return route.fulfill({ json: getView() });
    if (url.pathname.endsWith('/garmin/workouts')) {
      expect(url.searchParams.getAll('ids')).toEqual(['42']);
      return route.fulfill({ json: { workouts: [getView()], errors: {} } });
    }
    if (url.pathname.endsWith('/exports/batch')) {
      counts.exports++;
      expect(route.request().postDataJSON().session_ids).toEqual([42]);
      getView().export = state('scheduled');
      return route.fulfill({ json: { results: [getView().export], not_attempted: [] } });
    }
    if ((url.pathname.endsWith('/prescription') || url.pathname.endsWith('/planned/42')) && method === 'PUT') {
      counts.edits++;
      const data = route.request().postDataJSON();
      Object.assign(getView().session, { date: data.date, description: data.description, revision: 2, prescription: data.prescription });
      getView().export = state('dirty');
      return route.fulfill({ json: url.pathname.endsWith('/prescription') ? { updated: true } : getView().session });
    }
    if (url.pathname.endsWith('/workout-devices')) { counts.devices++; return route.fulfill({ json: [] }); }
    if (url.pathname.endsWith('/exports')) return route.fulfill({ json: getView().export ? [getView().export] : [] });
    if (url.pathname.endsWith('/planned')) return route.fulfill({ json: [getView().session] });
    if (url.pathname.includes('/settings')) return route.fulfill({ json: {} });
    return route.fulfill({ json: [] });
  });
  return counts;
}

for (const delay of [1_000, 10_000, 30_000]) {
  test(`cards stream before final answer with ${delay / 1000}s latency`, async ({ page }, testInfo) => {
    let view: WorkoutView = { session: structuredClone(session), export: null };
    const timers: ReturnType<typeof setTimeout>[] = [];
    const server = createServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', 'content-type');
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.flushHeaders();
      const body: { thread_id: string } = { thread_id: '' };
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        body.thread_id = JSON.parse(raw).thread_id;
        const send = (value: object) => response.write(`data: ${JSON.stringify(value)}\n\n`);
        view = { ...view, export: state('working') };
        send({ type: 'workout_update', id: 'export-42', thread_id: body.thread_id, sequence: 1, ...view });
        timers.push(setTimeout(() => {
          view = { ...view, export: state('scheduled') };
          send({ type: 'workout_update', id: 'export-42', thread_id: body.thread_id, sequence: 2, ...view });
        }, delay / 2));
        timers.push(setTimeout(() => {
          send({ type: 'done', message: { role: 'assistant', content: 'Ta séance est programmée dans Garmin Connect.' } });
          response.end();
        }, delay));
      });
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture server port');
    try {
      const counts = await mockApi(page, () => view, `http://127.0.0.1:${address.port}/stream`);
      await page.goto('/planning?date=2027-01-12');
      await page.getByRole('button', { name: 'Ouvrir le coach' }).first().click();
      const panel = page.getByRole('complementary', { name: 'Coach IA' });
      await panel.getByLabel('Message au coach').fill('Crée mon fractionné et envoie-le sur Garmin');
      const started = Date.now();
      await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
      await expect(panel.getByTestId('workout-42')).toBeVisible();
      const usefulMs = Date.now() - started;
      expect(usefulMs).toBeLessThan(delay);
      await expect(panel.getByText('Ta séance est programmée dans Garmin Connect.', { exact: true })).toHaveCount(0);
      await expect(panel.getByLabel('Message au coach')).toBeVisible();
      await panel.getByLabel('Message au coach').focus();
      if (delay >= 10_000) {
        await panel.getByRole('button', { name: 'Masquer le coach' }).click();
        await page.getByRole('button', { name: 'Ouvrir le coach' }).first().click();
        await expect(panel.getByTestId('workout-42')).toBeVisible();
      }
      await expect(panel.getByText('Ta séance est programmée dans Garmin Connect.', { exact: true })).toBeVisible({ timeout: 35_000 });
      await expect(panel.getByTestId('workout-42').getByText('Programmée dans Garmin Connect', { exact: true })).toBeVisible();
      if (delay === 1_000) await expect(panel.getByLabel('Message au coach')).toBeFocused();
      expect(counts.model).toBe(0); expect(counts.devices).toBe(0);
      const measures = await page.evaluate(() => performance.getEntriesByType('measure').filter(e => /coach:|workout:/.test(e.name)).map(e => ({ name: e.name, ms: e.duration })));
      const metrics = JSON.stringify({ delay, usefulMs, measures }, null, 2);
      await writeFile(`../.context/garmin-latency-${delay}.json`, metrics);
      await testInfo.attach('latency-measures', { body: metrics, contentType: 'application/json' });
      if (delay === 10_000) {
        await page.screenshot({ path: '../.context/garmin-chat-desktop.png', fullPage: true });
        await page.reload();
        await page.getByRole('button', { name: 'Ouvrir le coach' }).first().click();
        await expect(panel.getByTestId('workout-42').getByText('Programmée dans Garmin Connect', { exact: true })).toBeVisible();
      }
    } finally {
      timers.forEach(clearTimeout);
      server.closeAllConnections();
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
  });
}

test('Planning selection, direct export and editing work on mobile without model calls', async ({ page }) => {
  const view: WorkoutView = { session: structuredClone(session), export: null };
  const counts = await mockApi(page, () => view);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/planning?date=2027-01-12');
  await page.evaluate(() => document.documentElement.dataset.theme = 'pierre');
  await page.getByRole('button', { name: 'Options du planning', exact: true }).click();
  await page.getByRole('button', { name: 'Sélectionner', exact: true }).click();
  await page.getByLabel('Sélectionner Fractionné · 6 × 400 m').check();
  const send = page.getByRole('button', { name: 'Envoyer vers Garmin', exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByTestId('workout-42').getByText('Programmée dans Garmin Connect', { exact: true })).toBeVisible();
  expect(counts.exports).toBe(1); expect(counts.model).toBe(0); expect(counts.devices).toBe(0);
  await page.getByRole('button', { name: 'Ouvrir la séance Fractionné · 6 × 400 m', exact: true }).click();
  await page.getByRole('button', { name: 'Modifier', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Date', { exact: true }).fill('2027-01-13');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByTestId('workout-42').getByText('À resynchroniser', { exact: true })).toBeVisible();
  expect(counts.edits).toBe(1); expect(counts.exports).toBe(1); expect(counts.model).toBe(0);
  await page.screenshot({ path: '../.context/garmin-planning-mobile.png', fullPage: true });
});

test('Planning edits a description-read session starting from the steps read', async ({ page }) => {
  const description = "Échauffement 20-25', 12×400 @3'33 r1', retour 15'";
  const steps = [
    { kind: 'warmup' as const, duration_kind: 'seconds' as const, value: 1200, notes: "20-25'", steps: [] },
    { kind: 'repeat' as const, duration_kind: 'lap' as const, repeat: 12, steps: [
      { kind: 'effort' as const, duration_kind: 'meters' as const, value: 400, target: { kind: 'pace_sec_km' as const, low: 210, high: 216 }, steps: [] },
      { kind: 'recovery' as const, duration_kind: 'seconds' as const, value: 60, steps: [] },
    ] },
    { kind: 'cooldown' as const, duration_kind: 'seconds' as const, value: 900, steps: [] },
  ];
  const view: WorkoutView = { session: { ...structuredClone(session), description, derived: false, parsed: true, prescription: { version: 1, steps } }, export: null };
  const counts = await mockApi(page, () => view);
  let saved: unknown = null;
  // Stored without a prescription: the steps exist only as read by the server.
  await page.route(url => url.pathname.endsWith('/api/garmin/planned'), route =>
    route.fulfill({ json: [{ ...view.session, prescription: null }] }));
  await page.route(url => url.pathname.endsWith('/api/garmin/planned/42'), async route => {
    if (route.request().method() === 'PUT') saved = route.request().postDataJSON().prescription;
    await route.fallback();
  });
  await page.goto('/planning?date=2027-01-12');
  await page.getByRole('button', { name: 'Ouvrir la séance', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Étapes lues dans la description.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Modifier', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Type de l’étape 1', { exact: true }).first()).toHaveValue('warmup');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect.poll(() => counts.edits).toBe(1);
  expect(saved).toEqual({ version: 1, steps });
  expect(counts.model).toBe(0);
});

test('step durations and paces are typed as digits that format themselves on a phone', async ({ page }) => {
  const steps = [
    { kind: 'warmup' as const, duration_kind: 'seconds' as const, value: 1200, steps: [] },
    { kind: 'repeat' as const, duration_kind: 'lap' as const, repeat: 6, steps: [
      { kind: 'effort' as const, duration_kind: 'meters' as const, value: 400, target: { kind: 'pace_sec_km' as const, low: 210, high: 216 }, steps: [] },
    ] },
  ];
  const view: WorkoutView = { session: { ...structuredClone(session), prescription: { version: 1, steps } }, export: null };
  const counts = await mockApi(page, () => view);
  let saved: { steps: typeof steps } | null = null;
  await page.route(url => url.pathname.endsWith('/api/garmin/planned/42'), async route => {
    if (route.request().method() === 'PUT') saved = route.request().postDataJSON().prescription;
    await route.fallback();
  });
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/planning?date=2027-01-12');
  await page.getByRole('button', { name: 'Ouvrir la séance Fractionné · 6 × 400 m', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Modifier', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('summary', { hasText: '1. Échauffement' }).click();
  const duration = dialog.getByLabel('Durée (h:mm:ss)', { exact: true }).first();
  await expect(duration).toHaveValue('20:00');
  await expect(duration).toHaveAttribute('inputmode', 'numeric');
  await expect(dialog.getByText('Tape 2000 pour 20:00', { exact: true }).first()).toBeVisible();
  // A tap selects the value: the first digit restarts it, like a timer.
  await duration.click();
  await duration.pressSequentially('90');
  await expect(duration).toHaveValue('0:90');
  await duration.blur();
  await expect(duration).toHaveValue('1:30');
  await duration.click();
  await duration.pressSequentially('130000');
  await expect(duration).toHaveValue('13:00:00');
  // The caret stays at the end: Backspace removes the last digit wherever the athlete moved it.
  await duration.press('Home');
  await duration.press('Backspace');
  await expect(duration).toHaveValue('1:30:00');
  await dialog.locator('summary', { hasText: '2. Répéter un bloc' }).click();
  await dialog.locator('summary', { hasText: '1. Effort' }).click();
  const pace = dialog.getByLabel("Allure maximum (min'ss par km)", { exact: true });
  await expect(pace).toHaveValue("3'36");
  await expect(pace).toHaveAttribute('inputmode', 'numeric');
  await pace.click();
  await pace.pressSequentially('375');
  await expect(pace).toHaveValue("3'75");
  await pace.blur();
  await expect(pace).toHaveValue("4'15");
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect.poll(() => counts.edits).toBe(1);
  expect(saved!.steps[0].value).toBe(5400);
  expect(saved!.steps[1].steps[0].target).toEqual({ kind: 'pace_sec_km', low: 210, high: 255 });
});

test('uncertain export survives reload and is verified without replaying the write', async ({ page }) => {
  const view: WorkoutView = { session: structuredClone(session), export: null };
  const counts = await mockApi(page, () => view);
  let attempts = 0;
  let checks = 0;
  await page.route('**/api/garmin/exports/batch', async route => {
    attempts++;
    view.export = { ...state('uncertain'), error: 'Réponse perdue après envoi. Vérifie Garmin.' };
    await route.fulfill({ json: { results: [view.export], blocked: 42, error: view.export.error, not_attempted: [] } });
  });
  await page.route('**/api/garmin/exports/42/reconcile', async route => {
    checks++;
    view.export = state('ready');
    await route.fulfill({ json: view.export });
  });
  await page.goto('/planning?date=2027-01-12');
  await page.getByRole('button', { name: 'Options du planning', exact: true }).click();
  await page.getByRole('button', { name: 'Sélectionner', exact: true }).click();
  await page.getByLabel('Sélectionner Fractionné · 6 × 400 m').check();
  await page.getByRole('button', { name: 'Envoyer vers Garmin', exact: true }).click();
  const card = page.getByTestId('workout-42');
  await expect(card.getByText('Résultat indéterminé · vérifier Garmin', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Envoyer vers Garmin', exact: true })).toBeDisabled();
  await page.reload();
  await expect(card.getByText('Résultat indéterminé · vérifier Garmin', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Options du planning', exact: true }).click();
  await page.getByRole('button', { name: 'Sélectionner', exact: true }).click();
  await expect(page.getByLabel('Sélectionner Fractionné · 6 × 400 m')).toBeDisabled();
  await page.getByRole('button', { name: 'Ouvrir la séance', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Vérifier Garmin', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(card.getByText('Vérifiée · prête à envoyer', { exact: true })).toBeVisible();
  expect(attempts).toBe(1); expect(checks).toBe(1); expect(counts.model).toBe(0);
});


test('a run interrupted by closing the tab can be reconciled from its durable working state', async ({ page }) => {
  const view: WorkoutView = { session: structuredClone(session), export: { ...state('working'), updated_at: '2027-01-01T00:00:00' } };
  const counts = await mockApi(page, () => view);
  let checks = 0;
  await page.route('**/api/garmin/exports/42/reconcile', async route => {
    checks++;
    // The reconciled snapshot must follow the interrupted operation regardless
    // of the runner's date: the cache correctly rejects older export states.
    view.export = { ...state('ready'), updated_at: '2027-01-01T00:03:00' };
    await route.fulfill({ json: view.export });
  });
  await page.goto('/planning?date=2027-01-12');
  const card = page.getByTestId('workout-42');
  await page.getByRole('button', { name: 'Options du planning', exact: true }).click();
  await page.getByRole('button', { name: 'Sélectionner', exact: true }).click();
  await expect(page.getByLabel('Sélectionner Fractionné · 6 × 400 m')).toBeDisabled();
  await page.getByRole('button', { name: 'Ouvrir la séance', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Vérifier Garmin', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Vérifiée · prête à envoyer', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(card.getByText('Vérifiée · prête à envoyer', { exact: true })).toBeVisible();
  expect(checks).toBe(1); expect(counts.exports).toBe(0);
});

test('deletion commits once when Garmin removal fails and cleanup survives reload', async ({ page }) => {
  const view: WorkoutView = { session: structuredClone(session), export: state('scheduled') };
  await mockApi(page, () => view);
  let deleted = false;
  let deletions = 0;
  let removals = 0;
  await page.route(/\/api\/garmin\/planned(?:\?.*)?$/, route => route.fulfill({ json: deleted ? [] : [view.session] }));
  await page.route(/\/api\/garmin\/planned\/42\?revision=1$/, route => {
    deletions++;
    deleted = true;
    view.export = { ...state('pending_removal'), deleted: true };
    return route.fulfill({ json: { message: 'Session deleted' } });
  });
  await page.route('**/api/garmin/exports/42/remove', route => {
    removals++;
    if (removals === 1) return route.fulfill({ status: 502, json: { detail: 'Garmin indisponible' } });
    view.export = { ...state('removed'), deleted: true };
    return route.fulfill({ json: view.export });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/planning?date=2027-01-12');
  await page.getByRole('button', { name: 'Ouvrir la séance Fractionné · 6 × 400 m', exact: true }).click();
  await page.getByRole('button', { name: 'Supprimer la séance', exact: true }).click();
  await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Retrait Garmin à terminer' })).toBeVisible();
  expect(deletions).toBe(1);
  expect(removals).toBe(1);
  await page.reload();
  await expect(page.getByText('supprimée', { exact: false })).toBeVisible();
  await page.locator('summary').filter({ hasText: 'Gérer le retrait' }).click();
  await page.getByRole('button', { name: 'Retirer de Garmin Connect', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retirer de Garmin Connect', exact: true })).toHaveCount(0);
  expect(deletions).toBe(1);
  expect(removals).toBe(2);
});
