import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

/** Friday 16 October 2026, 20:20 in Paris: the evening message has just left. */
const NOW = new Date('2026-10-16T18:20:00Z');

/** Where the screens land: ARE64_SCREENS, else the untracked `.context`. */
const SCREENS = process.env.ARE64_SCREENS ?? '../.context/evening-message';

const message = {
  id: 7, date: '2026-10-16', for_date: '2026-10-17', reasons: ['session'],
  text: 'Demain, 50 min de tempo en Z4 : ta préparation est à 72, la forme suit. Il fera 9 °C vers 7 h. Comment sont tes jambes ce soir ?',
  question: 'Comment sont tes jambes ce soir ?',
  written_at: '2026-10-16T18:05:00+00:00', answer: null as string | null, answered_at: null as string | null,
};
const notice = {
  id: 'evening', title: 'Chiron, pour demain', body: message.question, url: '/follow-up?evening=7',
  created_at: '2026-10-16T18:05:00Z', read_at: null, archived_at: null,
};

/** The athlete's evening: every request but the auth configuration is recorded. */
async function evening(page: Page, settings: Record<string, unknown> = {}) {
  const requests: string[] = [];
  const answers: unknown[] = [];
  const saved: unknown[] = [];
  let answer: string | null = null;
  await page.clock.setFixedTime(NOW);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    localStorage.setItem('arete.install.dismissed', '1');
    localStorage.setItem('arete.notifications.offered', '1');
  });
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    requests.push(`${request.method()} ${path}`);
    if (path === '/api/settings' && request.method() === 'PUT') {
      saved.push(request.postDataJSON());
      return route.fulfill({ json: { ...DEFAULT_SETTINGS, ...request.postDataJSON(), user_id: 1 } });
    }
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, ...settings } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, opted_in: false, available: true, version: 1 } });
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'fresh' } });
    if (path === '/api/notifications') return route.fulfill({ json: { items: [notice], unread: 1, next_offset: null } });
    if (path === '/api/coach/today') return route.fulfill({ json: { date: message.date, items: [], remaining: 0, briefing: null } });
    if (path === '/api/coach/evening/7') return route.fulfill({ json: { ...message, answer, answered_at: answer ? '2026-10-16T18:22:00+00:00' : null, answerable: !answer, journaled: Boolean(answer) } });
    if (path === '/api/coach/evening/7/answer') {
      answers.push(request.postDataJSON());
      answer = (request.postDataJSON() as { text: string }).text;
      return route.fulfill({ json: { ...message, answer, answered_at: '2026-10-16T18:22:00+00:00', answerable: false, journaled: true, journal: 'written' } });
    }
    if (path === '/api/agent/memory') return route.fulfill({ json: { files: [] } });
    return route.fulfill({ json: [] });
  });
  return { requests, answers, saved };
}

for (const width of [375, 1440]) {
  test(`the push opens Chiron on the evening message and the answer costs no model request · ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
    const { requests, answers } = await evening(page);
    // The service worker opens the push's link.
    await page.goto('/follow-up?evening=7');
    const panel = page.getByRole('complementary', { name: 'Coach IA' });
    const card = panel.getByRole('region', { name: 'Message du soir dans cette conversation' });
    await expect(card.getByRole('heading')).toHaveText('Pour demain, samedi 17 octobre');
    await expect(card.getByText(message.question, { exact: true })).toBeVisible();
    await expect(card.getByRole('status')).toContainText('Réponds dans le champ ci-dessous');
    const composer = page.getByLabel('Message au coach');
    await expect(composer).toHaveValue(''); // never filled automatically
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${SCREENS}/push-opened-${width}.png`, animations: 'disabled' });

    await composer.fill('Un peu lourdes, nuit courte.');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect(card.getByRole('status')).toContainText('notée dans le journal de Chiron : « Un peu lourdes, nuit courte. »');
    await expect(panel.getByRole('article', { name: 'Ton message' })).toHaveText('Un peu lourdes, nuit courte.');
    await expect(composer).toHaveValue('');
    expect(answers).toEqual([{ text: 'Un peu lourdes, nuit courte.' }]);
    expect(requests.filter((r) => r.includes('/agent/chat'))).toEqual([]);
    await page.screenshot({ path: `${SCREENS}/answered-${width}.png`, animations: 'disabled' });

    // The inbox item leads back to the same conversation, answered once.
    await page.getByRole('button', { name: 'Masquer le coach', exact: true }).filter({ visible: true }).first().click();
    const item = page.getByRole('link', { name: /Chiron, pour demain/ });
    await expect(item).toContainText(message.question);
    await page.screenshot({ path: `${SCREENS}/inbox-${width}.png`, fullPage: true, animations: 'disabled' });
    await item.click();
    await expect(panel.getByRole('article', { name: 'Ton message' })).toHaveCount(1);
    expect(answers).toHaveLength(1);
  });
}

for (const width of [375, 1440]) {
  test(`the evening message is off until the athlete turns it on · ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
    const { saved } = await evening(page);
    await page.goto('/settings?tab=coach');
    const toggle = page.getByRole('checkbox', { name: /Le soir, Chiron t’écrit/ });
    await expect(toggle).not.toBeChecked();
    const hour = page.getByRole('combobox', { name: /À partir de/ });
    await expect(hour).toBeDisabled();
    await toggle.check();
    await hour.selectOption('21');
    await expect(page.getByRole('checkbox', { name: /Message du soir \(si activé/ })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await toggle.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SCREENS}/setting-${width}.png`, animations: 'disabled' });
    await page.getByRole('button', { name: /enregistrer/i }).click();
    await expect.poll(() => saved.length).toBe(1);
    expect(saved[0]).toMatchObject({ coach_evening_enabled: true, coach_evening_hour: 21 });
  });
}
