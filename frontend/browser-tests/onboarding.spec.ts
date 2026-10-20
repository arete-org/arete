import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer } from './dashboardAnswer';

const backend = 'http://127.0.0.1:8067';
let server: ChildProcess;
let directory: string;
let logs = '';
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'arete-onboarding-'));
  server = spawn('uv', ['run', 'uvicorn', 'onboarding_server:app', '--app-dir', 'frontend/browser-tests', '--host', '127.0.0.1', '--port', '8067'], {
    cwd: resolve('..'), env: { ...process.env, ARETE_DB: join(directory, 'test.duckdb'), ARETE_DATA_DIR: join(directory, 'files'), ARETE_AUTH: 'none', LANGSMITH_TRACING: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', data => { logs += String(data); });
  server.stderr?.on('data', data => { logs += String(data); });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(`${backend}/onboarding`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Startup may not have bound its port yet. */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Onboarding fixture did not start: ${logs}`);
});
test.afterAll(async () => {
  if (server?.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
  if (directory) await rm(directory, { recursive: true, force: true });
});

for (const [index, [theme, width]] of ([['pierre', 390], ['prune', 390], ['pierre', 1440], ['prune', 1440]] as const).entries()) {
  test(`real ledger handoff, resume and retry — ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
      localStorage.setItem('arete.install.dismissed', '1');
      localStorage.setItem('arete.notifications.offered', '1');
      if (!localStorage.getItem('arete.coach.threads.v1')) localStorage.setItem('arete.coach.threads.v1', JSON.stringify({ version: 1, activeId: 'previous', threads: [{ id: 'previous', title: 'Conversation précédente', createdAt: 1, updatedAt: 1, messages: [], draft: 'Brouillon précédent à préserver' }] }));
    });
    const athlete = String(101 + index);
    let rejectSave = true;
    let connected = false;
    let needsMfa = false;
    let imported = 0;
    let interrupted = true;
    const chats: { panel_context: Record<string, string>; thread_id: string }[] = [];
    const writes: { command_id: string; answers: Record<string, unknown> }[] = [];
    await page.route('**/api/**', async route => {
      const request = route.request(); const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/onboarding')) {
        if (request.method() === 'POST') {
          writes.push(request.postDataJSON());
          if (rejectSave) { rejectSave = false; return route.fulfill({ status: 503, json: { detail: 'Sauvegarde temporairement indisponible' } }); }
        }
        const response = await route.fetch({ url: backend + path.replace('/api', ''), headers: { ...request.headers(), 'x-test-athlete': athlete } });
        return route.fulfill({ response });
      }
      if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
      if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, theme, user_id: 1 } });
      if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false } });
      if (path === '/api/dashboard') return route.fulfill({ json: dashboardAnswer() });
      if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
      if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'disconnected' } });
      if (path === '/api/garmin/sync/status') return route.fulfill({ json: { garmin_authenticated: connected, activities_synced: imported, last_sync: imported ? '2026-10-17T08:00:00Z' : null, user_email: null } });
      if (path === '/api/garmin/sync/login') {
        if (!needsMfa) { needsMfa = true; return route.fulfill({ json: { needs_mfa: true } }); }
        connected = true; return route.fulfill({ json: { needs_mfa: false } });
      }
      if (path === '/api/garmin/sync/activities/stream') {
        if (interrupted) { interrupted = false; return route.fulfill({ status: 503, json: { detail: 'Garmin indisponible' } }); }
        imported = 2;
        return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'done', success: true, activities_synced: 2, activities_merged: 0, activities_matched: 0, activities_skipped: 0, errors: [], last_activity_date: '2026-10-16' })}\n\n` });
      }
      if (path === '/api/agent/chat/stream') { chats.push(request.postDataJSON()); return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'done', message: { role: 'assistant', content: 'Réponse simulée pour cette recette.' } })}\n\n` }); }
      return route.fulfill({ json: [] });
    });
    await page.goto('/onboarding');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCSS('font-family', /Cormorant/);
    if (width === 390) {
      // Browser emulation has no notch: exercise the safe-area token explicitly.
      await page.evaluate(() => document.documentElement.style.setProperty('--safe-top', '47px'));
      expect((await page.locator('.onboarding-header .arete-wordmark').boundingBox())!.y).toBeGreaterThanOrEqual(47);
      await page.evaluate(() => document.documentElement.style.removeProperty('--safe-top'));
    }
    await page.getByLabel('Ton prénom').fill('Camille');
    await page.locator('.onboarding-scroll').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: `../.context/onboarding/accueil-${theme}-${width}.png` });
    await page.getByRole('button', { name: /Préparer une course/ }).click();
    await page.getByLabel('Nom de la course').fill('Trail des crêtes — un premier défi ensemble');
    await page.getByLabel('En quelques mots').fill('Reprendre progressivement après une longue pause, avec des semaines de travail très variables.');
    await page.screenshot({ path: `../.context/onboarding/implementation-${theme}-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Continuer', exact: true }).click();
    await expect(page.getByLabel('Combien de séances')).toHaveValue('');
    await page.getByRole('button', { name: 'Course à pied', exact: true }).click();
    await page.getByRole('button', { name: 'Renforcement', exact: true }).click();
    await page.getByLabel('Combien de séances').fill('3');
    await page.getByLabel('Tes contraintes').fill('Le mercredi est réservé aux enfants.');
    if (width === 390) {
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 420 });
        window.visualViewport!.dispatchEvent(new Event('resize'));
      });
      const footer = page.locator('.onboarding-footer');
      await expect.poll(async () => (await footer.boundingBox())!.y + (await footer.boundingBox())!.height).toBeLessThanOrEqual(420);
      await expect(page.getByLabel('Tes contraintes')).toHaveCSS('font-size', '16px');
      await page.screenshot({ path: `../.context/onboarding/clavier-${theme}.png` });
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 900 });
        window.visualViewport!.dispatchEvent(new Event('resize'));
      });
    }
    await page.getByRole('button', { name: /^Confirmer / }).click();
    await page.getByRole('button', { name: 'Plus tard', exact: true }).click();
    await page.getByRole('link', { name: 'Terminer ma configuration' }).click();
    await page.reload();
    await expect(page.getByLabel('Combien de séances')).toHaveValue('3');
    await expect(page.getByLabel('Tes contraintes')).toHaveValue('Le mercredi est réservé aux enfants.');
    await page.getByRole('button', { name: 'Retour', exact: true }).click();
    await expect(page.getByLabel('Nom de la course')).toHaveValue('Trail des crêtes — un premier défi ensemble');
    await page.getByRole('button', { name: 'Continuer', exact: true }).click();
    await page.getByRole('button', { name: 'Continuer', exact: true }).click();
    await expect(page.getByText('Strava', { exact: false })).toHaveCount(0);
    // What Garmin records, then what Arete does with it: no setup jargon.
    await expect(page.getByRole('heading', { name: 'Garmin mesure, Arete ajuste.' })).toBeVisible();
    await expect(page.locator('.onboarding-garmin')).not.toContainText(/connexion|import/i);
    if (index % 2) {
      await page.getByRole('button', { name: 'Connecter Garmin', exact: true }).click();
      await page.getByLabel('[EMAIL]', { exact: true }).fill('camille@example.com');
      await page.getByLabel('[MOT DE PASSE]', { exact: true }).fill('illustration-only');
      await page.getByRole('button', { name: '[CONNECTER]', exact: true }).click();
      await page.getByLabel('[CODE]', { exact: true }).fill('123456');
      await page.getByRole('button', { name: '[VÉRIFIER]', exact: true }).click();
      await expect(page.getByText('Garmin connecté', { exact: true })).toBeVisible();
      await expect(page.getByText(/aucun import confirmé/)).toBeVisible();
      await page.getByRole('button', { name: 'Importer mes activités récentes' }).click();
      await expect(page.getByText('Synchronisation interrompue', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Réessayer l’import' }).click();
      await expect(page.getByText('Synchronisation terminée', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Continuer', exact: true }).click();
    } else await page.getByRole('button', { name: 'Continuer sans connexion' }).click();
    await expect(page.getByText('Repos : à préciser')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const tooSmall = await page.locator('.onboarding-shell button').evaluateAll(nodes => nodes.filter(n => n.getBoundingClientRect().height > 0 && n.getBoundingClientRect().height < 44).map(n => n.textContent));
    expect(tooSmall).toEqual([]);
    await page.getByRole('button', { name: 'Enregistrer et ouvrir Chiron' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Enregistrement non confirmé' })).toBeVisible();
    await expect(page.getByText('3 séance(s) par semaine')).toBeVisible();
    await page.getByRole('button', { name: 'Réessayer l’enregistrement' }).click();
    const panel = page.getByRole('complementary', { name: 'Coach IA' });
    await expect(panel.getByRole('region', { name: 'Ton point de départ' })).toContainText('Le mercredi est réservé aux enfants.');
    await expect(panel.getByLabel('Message au coach')).toHaveValue('');
    expect(chats).toEqual([]);
    expect(writes).toHaveLength(2);
    expect(writes[0].command_id).toBe(writes[1].command_id);
    const profile = await fetch(`${backend}/onboarding/context`, { headers: { 'x-test-athlete': athlete } }).then(r => r.json());
    expect(profile.content).toContain('Sports pratiqués : course à pied, renforcement');
    expect(profile.content).not.toContain('Non précisé');
    expect(profile.revision).toBe(1);
    await expect.poll(() => page.evaluate(() => {
      const store = JSON.parse(localStorage.getItem('arete.coach.threads.v1')!);
      return store.threads.find((t: { id: string }) => t.id === store.activeId)?.reference;
    })).toEqual({ kind: 'onboarding', id: 1 });
    const threads = await page.evaluate(() => JSON.parse(localStorage.getItem('arete.coach.threads.v1')!));
    expect(threads.threads.find((t: { id: string }) => t.id === 'previous').draft).toBe('Brouillon précédent à préserver');
    const active = threads.threads.find((t: { id: string }) => t.id === threads.activeId);
    expect(active.reference).toEqual({ kind: 'onboarding', id: 1 });
    expect(active.messages).toEqual([]);
    await page.reload();
    await page.getByRole('button', { name: 'Demander à Chiron', exact: true }).click();
    await expect(panel.getByRole('region', { name: 'Ton point de départ' })).toContainText('Camille');
    expect(chats).toEqual([]);
    await page.screenshot({ path: `../.context/onboarding/chiron-${theme}-${width}.png` });
    await panel.getByLabel('Message au coach').fill('Comment avancer vers mon objectif ?');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect.poll(() => chats.length).toBe(1);
    expect(chats[0].panel_context.param_coach_ref).toBe('onboarding:1');
    await expect(panel.getByText('Réponse simulée pour cette recette.')).toBeVisible();
    await panel.getByRole('button', { name: 'Options du coach' }).click();
    await panel.getByRole('button', { name: 'Historique des conversations' }).click();
    await panel.getByRole('button', { name: /Conversation précédente Brouillon/ }).click();
    await expect(panel.getByLabel('Message au coach')).toHaveValue('Brouillon précédent à préserver');
    await expect(panel.getByRole('region', { name: 'Ton point de départ' })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect.poll(() => chats.length).toBe(2);
    expect(chats[1].panel_context.param_coach_ref).toBeUndefined();
    expect(chats[1].thread_id).toBe('previous');
  });
}
