import { createServer, type ServerResponse } from 'node:http';
import type { Page } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

export async function coachStream(page: Page, enabled = true, initialDisplay: 'sidebar' | 'floating' = 'sidebar') {
  await page.addInitScript(mode => {
    if (!localStorage.getItem('arete.coach-display.v2')) localStorage.setItem('arete.coach-display.v2', mode);
  }, initialDisplay);
  let response: ServerResponse | undefined;
  let requests = 0;
  const server = createServer((request, outgoing) => {
    outgoing.setHeader('Access-Control-Allow-Origin', '*');
    outgoing.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (request.method === 'OPTIONS') { outgoing.writeHead(204); outgoing.end(); return; }
    requests++;
    request.resume();
    outgoing.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    outgoing.flushHeaders();
    response = outgoing;
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing stream fixture port');
  await page.addInitScript(url => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => originalFetch(input === '/api/agent/chat/stream' ? url : input, init);
  }, `http://127.0.0.1:${address.port}/stream`);
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/config')) return route.fulfill({ json: { enabled: false } });
    if (path.endsWith('/settings/gamification')) return route.fulfill({ json: { enabled, opted_in: enabled, available: true, version: 1 } });
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, theme: 'pierre' } });
    if (path.includes('/settings')) return route.fulfill({ json: {} });
    return route.fulfill({ json: [] });
  });
  return {
    requests: () => requests,
    send(event: object) {
      if (!response) throw new Error('No active stream');
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    async close() {
      response?.end();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
