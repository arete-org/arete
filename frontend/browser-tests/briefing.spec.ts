import { test, expect } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer, localDay } from './dashboardAnswer';

const text = 'Ta préparation reste basse ce matin. Garde une journée de repos ou une marche légère. Demain, on réévalue avant de reprendre la séance de qualité.';
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
    const stored = { reaction: null as string | null, reaction_comment: null };
    const requests: string[] = [];
    const writes: unknown[] = [];
    const chats: { panel_context: Record<string, string>; thread_id: string }[] = [];
    await page.route('**/api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/agent/conversations') return route.fulfill({ json: { items: [], next_offset: null } });
      if (path.startsWith('/api/agent/conversations/') && request.method() === 'PUT') { const body = request.postDataJSON(); return route.fulfill({ json: { revision: body.revision + 1, title: body.title } }); }
      if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
      requests.push(`${request.method()} ${path}`);
      if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
      if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, theme, user_id: 1, display_name: 'Arthur' } });
      if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, available: true } });
      if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'disconnected' } });
      if (path === '/api/dashboard') {
        const board = dashboardAnswer({ checkin: { date: localDay(), sleep: 4, legs: 3, mood: null, note: null, answered_at: `${localDay()}T07:00:00Z`, updated_at: `${localDay()}T07:00:00Z` } });
        return route.fulfill({ json: { ...board, briefing: { ...board.briefing, source: 'agent', tip: text, generated_at: `${localDay()}T07:00:00Z`, id: 41, ...stored } } });
      }
      if (path === '/api/tips/briefings/41') return route.fulfill({ json: { id: 41, date: localDay(), tip: text, source: 'agent', generated_at: `${localDay()}T07:00:00Z`, ...stored } });
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
    const entry = page.getByRole('button', { name: /^Briefing du jour/ });
    await expect(entry).toBeVisible();
    await expect(entry).toHaveCSS('font-family', /Inter/);
    const card = page.locator('.glass-panel').filter({ has: entry });
    await expect(card).toHaveCSS('border-radius', '16px');
    await expect(card.getByRole('group', { name: /avis/ })).toHaveCount(0);
    if (theme === 'pierre' && width === 390) await page.screenshot({ path: '../.context/briefing-01-dashboard.png' });
    expect(requests).not.toContain('GET /api/tips/history');
    await page.getByRole('button', { name: 'Briefings précédents' }).click();
    await expect(page.getByText('Hier : sortie tranquille.')).toBeVisible();
    await page.getByRole('button', { name: 'Briefings précédents' }).click();

    await page.getByRole('button', { name: 'Demander à Coach' }).click();
    const panel = page.getByRole('complementary', { name: 'Coach IA' });
    await panel.getByLabel('Message au coach').fill('Mon brouillon reste ici.');
    await panel.getByRole('button', { name: 'Masquer le coach' }).click();
    await entry.focus();
    await page.keyboard.press('Enter');
    await expect(panel.getByRole('region', { name: 'Briefing dans cette conversation' })).toContainText(text);
    await expect(panel.getByLabel('Message au coach')).toHaveValue('');
    await expect(panel.getByRole('heading', { name: 'Coach', exact: true })).toHaveCSS('font-family', /Cormorant Garamond/);
    await expect(panel.getByRole('button', { name: 'Briefing utile', exact: true }).locator('svg')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Briefing utile', exact: true })).toHaveCSS('border-radius', '9px');
    await expect(panel.getByLabel('Message au coach')).toBeInViewport();
    await expect(panel.getByRole('button', { name: 'Briefing utile', exact: true })).toHaveCSS('width', width === 390 ? '44px' : '32px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(chats).toHaveLength(0);
    expect(writes).toHaveLength(0);
    await expect.poll(() => page.evaluate(key => {
      const store = JSON.parse(localStorage.getItem(key)!);
      return store.threads.find((t: { reference?: unknown }) => t.reference)?.reference;
    }, storedKey)).toEqual({ kind: 'briefing', id: 41 });
    const original = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).threads.find((t: { draft: string }) => t.draft === 'Mon brouillon reste ici.').id, storedKey);
    const briefingThread = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).activeId, storedKey);
    expect(briefingThread).not.toBe(original);
    if (theme === 'pierre' && width === 390) await page.screenshot({ path: '../.context/briefing-02-thread.png' });
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
    await page.getByRole('button', { name: 'Demander à Coach' }).click();
    await expect(panel.getByRole('region', { name: 'Briefing dans cette conversation' })).toContainText(text);
    await expect(panel.getByRole('button', { name: 'Briefing utile', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await panel.getByRole('button', { name: 'Options du coach' }).click();
    await panel.getByRole('button', { name: 'Historique des conversations' }).click();
    await panel.getByRole('button', { name: /Nouvelle conversation Brouillon/ }).click();
    await expect(panel.getByLabel('Message au coach')).toHaveValue('Mon brouillon reste ici.');
    await expect(panel.getByRole('region', { name: 'Briefing dans cette conversation' })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect.poll(() => chats.length).toBe(2);
    expect(chats[1].panel_context.param_coach_ref).toBeUndefined();
    expect(chats[1].thread_id).toBe(original);
  });
  });
}
