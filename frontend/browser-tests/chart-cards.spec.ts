import { test, expect, type Locator, type Page } from '@playwright/test';
import { coachStream } from './coachStream';
import { THEMES } from '../src/lib/theme';

const line = {
  type: 'chart_card', version: 1, id: 'a'.repeat(64), title: 'Distance hebdomadaire',
  summary: '20, 30 puis 40 km du 28 septembre au 18 octobre. Source : séances enregistrées. La distance augmente chaque semaine.',
  height_px: 240,
  html: `<svg viewBox="0 0 320 200" role="img" aria-label="Distance hebdomadaire en kilomètres">
    <line class="chart-axis" x1="40" y1="160" x2="300" y2="160"/>
    <line class="chart-grid" x1="40" y1="40" x2="300" y2="40"/>
    <text class="chart-label" x="4" y="44">40 km</text><text class="chart-label" x="24" y="164">0</text>
    <polyline class="series-blue chart-line" points="60,100 170,70 280,40"/>
    <circle class="series-blue" cx="60" cy="100" r="3"/><circle class="series-blue" cx="170" cy="70" r="3"/><circle class="series-blue" cx="280" cy="40" r="3"/>
    <text class="chart-label" x="60" y="184" text-anchor="middle">S40</text><text class="chart-label" x="170" y="184" text-anchor="middle">S41</text><text class="chart-label" x="280" y="184" text-anchor="middle">S42</text>
  </svg>`,
};
const bars = {
  ...line, id: 'b'.repeat(64), title: 'Durée par sport', summary: '90 min de course et 60 min de vélo cette semaine. Source : séances enregistrées.',
  html: `<svg viewBox="0 0 320 200" role="img" aria-label="Durée par sport en minutes">
    <line class="chart-axis" x1="32" y1="160" x2="300" y2="160"/><text class="chart-label" x="12" y="164">0</text>
    <rect class="series-blue" x="60" y="40" width="64" height="120"/><rect class="series-green" x="196" y="80" width="64" height="80"/>
    <text class="chart-label" x="92" y="28" text-anchor="middle">90 min</text><text class="chart-label" x="228" y="68" text-anchor="middle">60 min</text>
    <text class="chart-label" x="92" y="184" text-anchor="middle">Course</text><text class="chart-label" x="228" y="184" text-anchor="middle">Vélo</text>
  </svg>`,
};

async function openCoach(page: Page) {
  await page.goto('/analytics');
  await page.getByRole('button', { name: /^(Ouvrir le coach|Demander à Chiron)$/ }).filter({ visible: true }).first().click();
  return page.getByRole('complementary', { name: 'Coach IA' });
}

async function chartStream(page: Page, display: 'sidebar' | 'floating' = 'floating') {
  const stream = await coachStream(page, true, display);
  const archives = new Map<string, Record<string, unknown>>();
  await page.route('**/api/agent/conversations**', route => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split('/')[4];
    if (!id) return route.fulfill({ json: { items: [], next_offset: null } });
    if (request.method() === 'PUT') {
      const body = request.postDataJSON();
      const saved = { ...body, id, revision: body.revision + 1, title_state: 'generated' };
      archives.set(id, saved);
      return route.fulfill({ json: saved });
    }
    return route.fulfill({ status: archives.has(id) ? 200 : 404, json: archives.get(id) ?? {} });
  });
  return { ...stream, archives };
}
async function display(panel: Locator, name: string) {
  const mode = name === 'Chat flottant' ? 'floating' : 'sidebar';
  if (await panel.getAttribute('data-display') === mode) return;
  await panel.getByRole('button', { name: 'Options du coach' }).click();
  await panel.getByRole('radio', { name, exact: true }).click();
  await expect(panel).toHaveAttribute('data-display', mode);
}

test('charts render in all themes and both chat modes, stay offline and survive reload', async ({ page }) => {
  const stream = await chartStream(page);
  const frameRequests: string[] = [];
  page.on('request', request => { if (request.frame().parentFrame()) frameRequests.push(request.url()); });
  try {
    const panel = await openCoach(page);
    await panel.getByLabel('Message au coach').fill('Montre ma distance et la durée par sport.');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect.poll(() => stream.requests()).toBe(1);
    stream.send({ type: 'message', id: 'intro', text: 'Voici tes données des trois dernières semaines.' });
    stream.send(line);
    stream.send(line);
    stream.send(bars);
    stream.send({ type: 'message', id: 'answer', text: 'Ta distance augmente ; garde la récupération en tête.' });
    stream.send({ type: 'done', message: { role: 'assistant', content: 'Ta distance augmente ; garde la récupération en tête.' } });
    const card = panel.getByRole('figure', { name: line.title });
    await expect(card).toHaveCount(1);
    await expect(panel.locator('iframe')).toHaveCount(2);
    await panel.getByLabel('Message au coach').fill('Mon brouillon reste ici.');
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      for (const mode of ['Chat flottant', 'Panneau latéral classique']) {
        await display(panel, mode);
        for (const { value: theme } of THEMES) {
          await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
          for (const title of [line.title, bars.title]) {
            const frame = panel.locator(`iframe[title="${title}"]`);
            await expect(frame).toHaveAttribute('sandbox', '');
            const content = frame.contentFrame();
            await expect(content.locator('svg')).toHaveCount(1);
            const expectedColor = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-chart-blue').trim());
            await expect.poll(() => content.locator('html').evaluate(node => getComputedStyle(node).getPropertyValue('--color-chart-blue').trim())).toBe(expectedColor);
            expect(await content.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
            expect(await content.locator('body').evaluate(node => node.scrollHeight <= document.documentElement.clientHeight)).toBe(true);
            await expect(content.locator('text').first()).toHaveCSS('font-family', 'Inter, sans-serif');
            await content.locator('body').evaluate(async () => { await document.fonts.ready; });
            expect(await content.locator('body').evaluate(() => document.fonts.check('12px Inter'))).toBe(true);
          }
          expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
          await expect(panel.getByLabel('Message au coach')).toHaveValue('Mon brouillon reste ici.');
          if (theme === 'pierre' && mode === (width === 390 ? 'Chat flottant' : 'Panneau latéral classique')) {
            await card.scrollIntoViewIfNeeded();
            await card.screenshot({ path: `../.context/chiron-chart-${width === 390 ? 'mobile' : 'desktop'}.png` });
          }
        }
      }
    }
    expect(frameRequests).toEqual([]);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('arete.coach.threads.v1'))).toContain(line.title);
    await expect.poll(() => stream.archives.size).toBe(1);
    const beforeReload = [...stream.archives.values()][0];
    await page.reload();
    // Sidebar stays mounted after reload; reopen only if the restored mode is collapsed.
    if (!await panel.isVisible()) await page.getByRole('button', { name: /^(Ouvrir le coach|Demander à Chiron)$/ }).filter({ visible: true }).first().click();
    await expect(panel.locator('iframe')).toHaveCount(2);
    await expect(panel.getByLabel('Message au coach')).toHaveValue('Mon brouillon reste ici.');
    // Restoring settles transient message flags; wait for that snapshot's ack
    // before asking the archive to replace a clean local copy.
    await expect.poll(() => Number(stream.archives.get(String(beforeReload.id))?.revision)).toBeGreaterThan(Number(beforeReload.revision));
    const archive = [...stream.archives.values()][0];
    await expect.poll(() => page.evaluate(id => {
      const store = JSON.parse(localStorage.getItem('arete.coach.threads.v1')!);
      return store.threads.find((thread: { id: string }) => thread.id === id)?.archiveRevision;
    }, archive.id)).toBe(archive.revision);
    expect(JSON.stringify(archive)).not.toContain('<svg');
    expect(JSON.stringify(archive)).toContain(line.summary);
    // Loading the server's textual archive retains this device's full charts.
    archive.title = 'Distances archivées';
    const archiveRead = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith(`/agent/conversations/${archive.id}`));
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('arete:conversation-open', { detail: id })), archive.id);
    await archiveRead;
    await expect.poll(() => page.evaluate(id => {
      const store = JSON.parse(localStorage.getItem('arete.coach.threads.v1')!);
      return store.threads.find((thread: { id: string }) => thread.id === id)?.title;
    }, archive.id)).toBe('Distances archivées');
    await expect(panel.locator('iframe')).toHaveCount(2);
    await expect(panel.getByLabel('Message au coach')).toHaveValue('Mon brouillon reste ici.');
    expect(stream.requests()).toBe(1);
  } finally { await stream.close(); }
});

test('late charts remain with their original thread while draft and display mode change', async ({ page }) => {
  const stream = await chartStream(page);
  try {
    const panel = await openCoach(page);
    await panel.getByLabel('Message au coach').fill('Ma courbe de distance');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect.poll(() => stream.requests()).toBe(1);
    stream.send(line);
    await expect(panel.locator('iframe')).toHaveCount(1);
    await display(panel, 'Panneau latéral classique');
    await display(panel, 'Chat flottant');
    await expect(panel.locator('iframe')).toHaveCount(1);
    await panel.getByRole('button', { name: 'Options du coach' }).click();
    await panel.getByRole('button', { name: 'Nouvelle conversation', exact: true }).click();
    await panel.getByLabel('Message au coach').fill('Brouillon du second fil');
    stream.send(bars);
    stream.send({ type: 'message', id: 'answer', text: 'Ta distance a augmenté.' });
    stream.send({ type: 'done', message: { role: 'assistant', content: 'Ta distance a augmenté.' } });
    await expect(panel.locator('iframe')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Options du coach' }).click();
    await panel.getByRole('button', { name: 'Historique des conversations' }).click();
    await panel.getByRole('button', { name: /^Ma courbe de distance/ }).click();
    await expect(panel.locator('iframe')).toHaveCount(2);
    await panel.getByRole('button', { name: 'Options du coach' }).click();
    await panel.getByRole('button', { name: 'Historique des conversations' }).click();
    await panel.getByRole('button', { name: /^Nouvelle conversation Brouillon/ }).click();
    await expect(panel.getByLabel('Message au coach')).toHaveValue('Brouillon du second fil');
    await expect(panel.locator('iframe')).toHaveCount(0);
    expect(stream.requests()).toBe(1);
  } finally { await stream.close(); }
});

test('sandbox blocks scripts and network even if a document bypassed sanitization', async ({ page }) => {
  const stream = await chartStream(page, 'sidebar');
  let leaked = 0;
  await page.route('**/chart-exfil/**', route => { leaked++; return route.abort(); });
  try {
    const panel = await openCoach(page);
    await panel.getByLabel('Message au coach').fill('Un graphique');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect.poll(() => stream.requests()).toBe(1);
    stream.send(line);
    const frame = panel.locator('iframe');
    await expect(frame).toHaveCount(1);
    await frame.evaluate(node => {
      const frame = node as HTMLIFrameElement;
      frame.srcdoc = frame.srcdoc.replace('</body>', '<script>parent.document.body.dataset.chartPwned="yes";fetch("/chart-exfil/script")</script><img src="https://example.com/chart-exfil/image"></body>');
    });
    await expect(frame.contentFrame().locator('img')).toHaveCount(1);
    expect(await page.locator('body').getAttribute('data-chart-pwned')).toBeNull();
    expect(leaked).toBe(0);
    expect(await frame.evaluate(node => (node as HTMLIFrameElement).contentDocument)).toBeNull();
    stream.send({ ...bars, html: bars.html + '<script>alert(1)</script>' });
    await expect(panel.getByRole('figure', { name: bars.title }).getByRole('alert')).toContainText('Graphique indisponible');
    await expect(panel.getByText(bars.summary)).toBeVisible();
  } finally { await stream.close(); }
});
