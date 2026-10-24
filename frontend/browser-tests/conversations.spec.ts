import { test, expect } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

for (const width of [390, 1440]) test(`saved conversations, search and draft isolation at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const old = '81dca681-de27-4b1a-9c07-059517e00f40';
  const local = '57bde71d-36ae-4a5c-984a-29183c87ec51';
  await page.addInitScript(({ local }) => {
    localStorage.setItem('arete.install.dismissed', '1');
    localStorage.setItem('arete.notifications.offered', '1');
    localStorage.setItem('arete.coach.threads.v1', JSON.stringify({ version: 1, activeId: local, threads: [{ id: local, title: 'Mon brouillon', createdAt: 1, updatedAt: 1, messages: [], draft: 'Garder mes sensations' }] }));
  }, { local });
  let chatCalls = 0;
  const saves: unknown[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, theme: width === 390 ? 'prune' : 'pierre', user_id: 1 } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/agent/conversations') return route.fulfill({ json: { items: url.searchParams.get('q') === 'introuvable' ? [] : [{ id: old, title: 'Footing et Hyrox', updated_at: '2026-10-17T14:30:00Z', revision: 1, excerpt: 'Renfo léger après le footing.', excerpt_truncated: false, url: `/follow-up?tab=conversations&thread=${old}` }], next_offset: null } });
    if (path === `/api/agent/conversations/${old}` && request.method() === 'GET') return route.fulfill({ json: { id: old, title: 'Footing et Hyrox', revision: 1, title_state: 'generated', created_at: 1, updated_at: 2, messages: [{ role: 'user', content: 'Quel renfo après le footing ?' }, { role: 'assistant', content: 'Renfo léger après le footing.' }] } });
    if (path.startsWith('/api/agent/conversations/') && request.method() === 'PUT') { const body = request.postDataJSON(); saves.push(body); return route.fulfill({ json: { revision: body.revision + 1, title: body.title } }); }
    if (path === '/api/agent/chat/stream') { chatCalls++; return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'thread_title', thread_id: request.postDataJSON().thread_id, title: 'Récupération après Hyrox' })}\n\ndata: ${JSON.stringify({ type: 'done', message: { role: 'assistant', content: 'Garde une journée légère.' } })}\n\n` }); }
    return route.fulfill({ json: [] });
  });
  await page.goto('/follow-up?tab=conversations');
  await page.getByRole('button', { name: /Footing et Hyrox Sauvegardée/ }).click();
  const panel = page.getByRole('region', { name: 'Coach IA' });
  await expect(panel.getByText('Renfo léger après le footing.', { exact: true })).toBeVisible();
  expect(chatCalls).toBe(0);
  await expect(panel.getByLabel('Message au coach')).toHaveValue('');
  await panel.getByLabel('Message au coach').fill('Et demain ?');
  await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
  await expect(panel.getByText('Garde une journée légère.')).toBeVisible();
  await expect.poll(() => saves.length).toBeGreaterThan(0);
  await panel.getByRole('button', { name: 'Options du coach' }).click();
  await panel.getByRole('button', { name: 'Historique des conversations' }).click();
  await panel.getByRole('button', { name: /Mon brouillon Brouillon/ }).click();
  await expect(panel.getByLabel('Message au coach')).toHaveValue('Garder mes sensations');
  expect(chatCalls).toBe(1);
  await panel.getByRole('button', { name: 'Retour à la page' }).click();
  await page.getByLabel('Rechercher dans les conversations').fill('introuvable');
  await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
  await expect(page.getByText('Aucune conversation trouvée.')).toBeVisible();
  await page.getByLabel('Rechercher dans les conversations').fill('Hyrox');
  await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
  await expect(page.getByText('Footing et Hyrox', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `../.context/conversations-${width}.png`, fullPage: true });
});
