import { test, expect } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { coachStream } from './coachStream';
import { dashboardAnswer, localDay } from './dashboardAnswer';

const text = 'Ta préparation reste basse ce matin. Garde une journée de repos ou une marche légère. Demain, on réévalue avant de reprendre la séance de qualité.';
const evidence = [
  { label: 'Préparation', value: '18 / 100', source: 'Préparation Garmin', measured_on: localDay() },
  { label: 'Jambes', value: '2 / 5', source: 'Ton ressenti', measured_on: localDay() },
  { label: 'Équilibre de charge', value: '1,01', source: 'ACWR · 28 jours', measured_on: localDay() },
];
const storedKey = 'arete.coach.threads.v1';

for (const theme of ['pierre', 'prune']) for (const width of [390, 1440]) {
  test.describe(`${theme} ${width}`, () => {
    test.use({ hasTouch: width === 390 });
  test(`briefing opens its own Chiron thread and shared feedback — ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
      localStorage.setItem('arete.install.dismissed', '1');
      localStorage.setItem('arete.notifications.offered', '1');
    });
    const documents = new Map<string, { id: string; name: string; status: string }[]>();
    const stored = { reaction: null as string | null, reaction_comment: null };
    const requests: string[] = [];
    const writes: unknown[] = [];
    const chats: { panel_context: Record<string, string>; thread_id: string }[] = [];
    await page.route('**/api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const documentPath = path.match(/^\/api\/agent\/threads\/([^/]+)\/documents(.*)$/);
      if (documentPath) {
        const [, thread, suffix] = documentPath;
        const doc = { id: 'document-a', name: 'semaine.txt', status: 'ready' };
        if (!suffix && request.method() === 'GET') return route.fulfill({ json: documents.get(thread) ?? [] });
        if (suffix.endsWith('/finalize')) documents.set(thread, [doc]);
        return route.fulfill({ json: doc });
      }
      if (path === '/api/agent/conversations') return route.fulfill({ json: { items: [], next_offset: null } });
      if (path.startsWith('/api/agent/conversations/') && request.method() === 'PUT') { const body = request.postDataJSON(); return route.fulfill({ json: { revision: body.revision + 1, title: body.title } }); }
      if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
      requests.push(`${request.method()} ${path}`);
      if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
      if (path === '/api/onboarding') return route.fulfill({ json: { status: 'completed', revision: 1 } });
      if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, theme, user_id: 1, display_name: 'Arthur' } });
      if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, available: true } });
      if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'disconnected' } });
      if (path === '/api/dashboard') {
        const day = localDay();
        const base = dashboardAnswer();
        const board = dashboardAnswer({
          next_goal: { id: 3, name: 'Semi de Bordeaux', race_date: localDay(16), distance_km: 21.1, target_time_sec: null, priority: 'A', status: 'active', days_left: 16, created_at: null },
          fitness: { ...base.fitness, readiness_score: 1, readiness_source: 'garmin_training', readiness_measured_on: day },
          // The raw modeled health score must never override the canonical score of 1.
          health: { date: day, readiness_score: 47, training_readiness_score: 1 },
          player_stats: { ...base.player_stats, xp: { ...base.player_stats.xp, current: 481 } },
          actual: [{ id: 7, planned_session_id: null, date: day, start_time: null, sport: 'running', session_type: 'endurance', name: 'Course à pied', duration_sec: 2640, distance_km: 9.4, rpe: 5, exercises: [] }],
          strength: [{ id: 2, date: day, name: 'Musculation', duration_min: 40, overall_rpe: 6, exercise_names: ['Squat', 'Développé couché'], total_sets: 12, garmin_activity_id: null }],
          checkin: { date: localDay(), sleep: 4, legs: 2, mood: null, note: null, answered_at: `${localDay()}T07:00:00Z`, updated_at: `${localDay()}T07:00:00Z` } });
        return route.fulfill({ json: { ...board, briefing: { ...board.briefing, source: 'agent', tip: text, generated_at: `${localDay()}T07:00:00Z`, id: 41, ...stored } } });
      }
      if (path === '/api/tips/briefings/41') return route.fulfill({ json: { id: 41, date: localDay(), tip: text, evidence, source: 'agent', generated_at: `${localDay()}T07:00:00Z`, ...stored } });
      if (path === '/api/tips/briefings/41/reaction') {
        const body = request.postDataJSON(); writes.push(body);
        Object.assign(stored, { reaction: body.reaction, reaction_comment: body.comment });
        return route.fulfill({ json: { id: 41, ...stored } });
      }
      if (path === '/api/tips/history') return route.fulfill({ json: [{ id: 30, date: localDay(-1), tip: 'Hier : sortie tranquille.', source: 'agent', generated_at: null, reaction: null, reaction_comment: null }] });
      if (path === '/api/agent/chat/stream') {
        chats.push(request.postDataJSON());
        return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'done', message: { role: 'assistant', content: 'Oui, une marche légère suffit. On réévalue demain.' } })}\n\n` });
      }
      return route.fulfill({ json: [] });
    });
    await page.goto('/');
    const entry = page.getByRole('button', { name: 'En parler au coach' });
    await expect(entry).toBeVisible();
    await expect(page.getByText('Tes bilans et échanges', { exact: true })).toBeVisible();
    await expect(page.getByText('1 / 100', { exact: true })).toBeVisible();
    await expect(page.getByText(/2 séances terminées · 1h24 au total/)).toBeVisible();
    await expect(page.getByRole('link', { name: /Course à pied · 44min · 9,4 km/ })).toHaveAttribute('href', '/log/sessions/7');
    await expect(page.getByRole('link', { name: /Musculation · 40min/ })).toHaveAttribute('href', '/log?session=2');
    if (width === 1440) {
      const sessions = (await page.getByRole('heading', { name: 'Tes séances' }).boundingBox())!;
      const markers = (await page.getByRole('heading', { name: 'Tes repères' }).boundingBox())!;
      expect(Math.abs(sessions.y - markers.y)).toBeLessThan(2);
    }
    await expect(page.getByRole('heading', { name: 'Courbe de forme' })).toHaveCount(0);
    expect(requests.some(request => request.includes('/form-curve'))).toBe(false);
    await expect(entry).toHaveCSS('font-family', /Inter/);
    const card = page.locator('.glass-panel').filter({ has: entry });
    await expect(card).toHaveCSS('border-radius', '16px');
    await expect(card.getByRole('group', { name: /avis/ })).toHaveCount(0);
    if (theme === 'pierre') await page.screenshot({ path: `../.context/briefing-home-${width}.png`, fullPage: true });
    expect(requests).not.toContain('GET /api/tips/history');
    await page.getByRole('button', { name: 'Briefings précédents' }).click();
    await expect(page.getByText('Hier : sortie tranquille.')).toBeVisible();
    await page.getByRole('button', { name: 'Briefings précédents' }).click();

    await page.getByRole('button', { name: 'Demander au coach' }).click();
    const panel = page.getByRole('region', { name: 'Coach IA' });
    await panel.getByLabel('Message au coach').fill('Mon brouillon reste ici.');
    await panel.getByLabel('Joindre des documents', { exact: true }).setInputFiles({ name: 'semaine.txt', mimeType: 'text/plain', buffer: Buffer.from('Séance de récupération.') });
    await expect(panel.getByRole('button', { name: 'Fichiers du fil (1)' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Envoyer', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: 'Retour à la page' }).click();
    await entry.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/coach$/);
    await expect(page.getByRole('main').getByRole('region', { name: 'Coach IA' })).toBeVisible();
    await expect(panel).toHaveCSS('position', 'relative');
    await expect(panel).toHaveAttribute('data-display', 'embedded');
    await expect(panel.getByRole('region', { name: 'Briefing dans cette conversation' })).toContainText(text);
    await expect(panel.getByLabel('Message au coach')).toHaveValue('');
    await expect(panel.getByRole('button', { name: /Fichiers du fil/ })).toHaveCount(0);
    await expect(panel.getByRole('heading', { name: 'Coach', exact: true })).toHaveCSS('font-family', /Cormorant Garamond/);
    await expect(panel.getByRole('button', { name: 'Briefing utile', exact: true }).locator('svg')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Briefing utile', exact: true })).toHaveCSS('border-radius', '9px');
    await expect(panel.getByLabel('Message au coach')).toBeInViewport();
    await expect(panel.getByRole('button', { name: 'Briefing utile', exact: true })).toHaveCSS('width', width === 390 ? '44px' : '32px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(panel.getByText('18 / 100', { exact: true })).toBeVisible();
    expect(chats).toHaveLength(0);
    expect(writes).toHaveLength(0);
    await expect.poll(() => page.evaluate(key => {
      const store = JSON.parse(localStorage.getItem(key)!);
      return store.threads.find((t: { reference?: unknown }) => t.reference)?.reference;
    }, storedKey)).toEqual({ kind: 'briefing', id: 41 });
    const original = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).threads.find((t: { draft: string }) => t.draft === 'Mon brouillon reste ici.').id, storedKey);
    const briefingThread = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).activeId, storedKey);
    expect(briefingThread).not.toBe(original);
    if (theme === 'pierre') await page.screenshot({ path: `../.context/briefing-discussion-${width}.png` });
    await panel.getByRole('button', { name: 'Briefing utile', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Briefing utile', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(writes).toEqual([{ reaction: 'up', comment: null }]);
    await panel.getByLabel('Message au coach').fill('Une marche suffit ?');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect(panel.getByText('Oui, une marche légère suffit. On réévalue demain.')).toBeVisible();
    expect(chats).toHaveLength(1);
    expect(chats[0].panel_context.param_coach_ref).toBe('briefing:41');
    expect(chats[0].thread_id).toBe(briefingThread);
    if (theme === 'pierre' && width === 390) await page.screenshot({ path: '../.context/briefing-03-discussion.png' });
    await page.reload();
    await expect(page).toHaveURL(/\/coach$/);
    await expect(panel.getByRole('region', { name: 'Briefing dans cette conversation' })).toContainText(text);
    await expect(panel.getByRole('button', { name: 'Briefing utile', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await panel.getByRole('button', { name: 'Options du coach' }).click();
    await panel.getByRole('button', { name: 'Historique des conversations' }).click();
    await panel.getByRole('button', { name: /Nouvelle conversation Brouillon/ }).click();
    await expect(panel.getByLabel('Message au coach')).toHaveValue('Mon brouillon reste ici.');
    await panel.getByRole('button', { name: 'Fichiers du fil (1)' }).click();
    await expect(panel.getByRole('checkbox', { name: 'semaine.txt' })).toBeChecked();
    await panel.getByRole('button', { name: 'Fermer les fichiers' }).click();
    await expect(panel.getByRole('region', { name: 'Briefing dans cette conversation' })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect.poll(() => chats.length).toBe(2);
    expect(chats[1].panel_context.param_coach_ref).toBeUndefined();
    expect(chats[1].thread_id).toBe(original);
  });
  });
}


for (const width of [390, 1440]) test(`opening a briefing preserves the original stream at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const stream = await coachStream(page, false, 'floating');
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/dashboard') return route.fulfill({ json: dashboardAnswer({ checkin: { date: localDay(), sleep: 4, legs: 3 } }) });
    if (path === '/api/tips/briefings/1') return route.fulfill({ json: { id: 1, date: localDay(), tip: text, source: 'agent', evidence, reaction: null, reaction_comment: null } });
    return route.fallback();
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Demander au coach' }).click();
    const panel = page.getByRole('region', { name: 'Coach IA' });
    await panel.getByLabel('Message au coach').fill('Comment organiser ma semaine ?');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect.poll(stream.requests).toBe(1);
    stream.send({ type: 'token', id: 'answer', text: 'Réponse dans le fil initial.' });
    await expect(panel.getByText('Réponse dans le fil initial.')).toBeVisible();
    await panel.getByLabel('Message au coach').fill('Brouillon pendant la réponse.');
    await panel.getByRole('button', { name: 'Retour à la page' }).click();
    await page.getByRole('button', { name: 'En parler au coach', exact: true }).click();
    await expect(panel.getByRole('region', { name: 'Briefing dans cette conversation' })).toBeVisible();
    stream.send({ type: 'token', id: 'answer', text: ' Terminée.' });
    stream.send({ type: 'done', message: { role: 'assistant', content: 'Réponse dans le fil initial. Terminée.' } });
    await expect(panel.getByText('Réponse dans le fil initial. Terminée.')).toHaveCount(0);
    await expect(panel.getByLabel('Message au coach')).toHaveValue('');
    expect(stream.requests()).toBe(1);
    await panel.getByRole('button', { name: 'Options du coach' }).click();
    await panel.getByRole('button', { name: 'Historique des conversations' }).click();
    await panel.getByRole('button', { name: /^Comment organiser ma semaine/ }).click();
    await expect(panel.getByText('Réponse dans le fil initial. Terminée.')).toBeVisible();
    await expect(panel.getByLabel('Message au coach')).toHaveValue('Brouillon pendant la réponse.');
  } finally {
    await stream.close();
  }
});
