import { expect, test, type Page } from '@playwright/test';
import { coachStream } from './coachStream';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer } from './dashboardAnswer';

test.setTimeout(30_000);

async function fixture(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    localStorage.setItem('arete.coach-display.v1', 'sidebar');
    localStorage.setItem('arete.install.dismissed', '1');
    localStorage.setItem('arete.notifications.offered', '1');
  });
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, theme: 'odyssey', display_name: 'Arthur' } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, available: true } });
    if (path === '/api/dashboard') return route.fulfill({ json: dashboardAnswer() });
    if (path === '/api/strength/stats/muscles') return route.fulfill({ json: { muscles: [{ muscle: 'chest', label: 'Pectoraux', volume: 1200, sets: 3, level: 2, previous_volume: 900, last_trained: '2026-10-13' }] } });
    return route.fulfill({ json: [] });
  });
}

async function safeArea(page: Page) {
  // Browser emulation has no physical notch: exercise the same CSS tokens explicitly.
  await page.evaluate(() => {
    for (const [name, value] of Object.entries({ '--safe-top': '47px', '--safe-bottom': '34px', '--safe-left': '0px', '--safe-right': '0px' })) {
      document.documentElement.style.setProperty(name, value);
    }
  });
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const width of [320, 390, 430]) {
  test(`mobile ${width}: safe areas, sticky entry, navigation and history`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await fixture(page);
    await page.goto('/log');
    await safeArea(page);
    const heading = page.getByRole('heading', { name: 'Journal', exact: true });
    await expect(heading).toBeVisible();
    expect((await heading.boundingBox())!.y).toBeGreaterThanOrEqual(47);
    const nav = page.getByRole('navigation', { name: 'Navigation mobile' });
    await expect(nav.getByRole('link')).toHaveText(['Accueil', 'Planning', 'Analyses', 'Journal', 'Profil', 'Réglages']);
    for (const link of await nav.getByRole('link').all()) {
      const box = (await link.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await noOverflow(page);
    await page.locator('svg[aria-label="Silhouette Face"] g').filter({ has: page.locator('title', { hasText: 'Pectoraux' }) }).locator('path').first().tap();
    await heading.tap();
    await expect(page.locator('[aria-live="polite"]').getByText('Pectoraux', { exact: true })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const content = (await page.locator('.page-shell').boundingBox())!;
    const bubble = (await page.getByRole('button', { name: 'Demander au coach' }).boundingBox())!;
    // WebKit rounds scroll offsets to device pixels; allow one CSS pixel at the boundary.
    expect(content.y + content.height).toBeLessThanOrEqual(bubble.y + 1);
    await page.evaluate(() => window.scrollTo(0, 350));
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(100);
    const position = await page.evaluate(() => scrollY);
    const entry = page.getByRole('button', { name: 'Saisir une séance', exact: true });
    expect((await entry.boundingBox())!.y).toBeGreaterThanOrEqual(47);
    await expect(entry).toBeInViewport();
    await entry.tap();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('button', { name: 'Demander au coach' })).toBeHidden();
    await dialog.getByRole('button', { name: 'Fermer', exact: true }).tap();
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(position, 0);
    await nav.getByRole('link', { name: 'Planning', exact: true }).tap();
    await expect(page.getByRole('heading', { name: 'Planning', exact: true })).toBeInViewport();
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
    const days = page.getByRole('group', { name: 'Jours de la semaine' });
    await expect(days.getByRole('button')).toHaveCount(7);
    for (const day of await days.getByRole('button').all()) {
      await expect(day).toBeInViewport();
      expect((await day.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    }
    await noOverflow(page);
    await page.screenshot({ path: `../.context/mobile-planning-${width}-${info.project.name}.png` });
    await page.goBack();
    await expect(heading).toBeVisible();
    await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(position, 0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `../.context/mobile-journal-${width}-${info.project.name}.png` });
    await page.getByRole('button', { name: 'Cardio', exact: true }).tap();
    await entry.tap();
    await expect(dialog.getByRole('heading', { name: 'Séance sans montre' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Fermer' }).tap();
    await nav.getByRole('link', { name: 'Tableau de bord' }).tap();
    // The RPG is off: the day's form reads in plain words, with no game tag nor level.
    await page.getByRole('button', { name: 'Détails de ma forme' }).tap();
    const form = page.locator('#dashboard-details');
    await expect(page.getByRole('heading', { name: 'Tes repères' })).toBeVisible();
    await expect(form.getByText('Charge de la semaine')).toBeVisible();
    await expect(form.getByText(/^(HP|MP|XP|TSS)$/)).toHaveCount(0);
    await expect(form.getByText(/joueur|niveau/i)).toHaveCount(0);
    await noOverflow(page);
    await page.getByRole('link', { name: 'Saisir une séance', exact: true }).tap();
    await expect(dialog.getByRole('heading', { name: 'Saisir une séance' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Fermer', exact: true }).tap();
    await nav.getByRole('link', { name: 'Profil', exact: true }).tap();
    await expect(page.getByRole('heading', { name: 'Mon profil' })).toBeInViewport();
    await expect(page.getByText('Active la gamification', { exact: false })).toBeVisible();
  });
}

test('embedded coach preserves the source page, draft and keyboard space', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.goto('/log');
  await safeArea(page);
  const launcher = page.getByRole('button', { name: 'Demander au coach', exact: true });
  await launcher.tap();
  const panel = page.getByRole('region', { name: 'Coach IA' });
  await expect(panel).toHaveAttribute('data-display', 'embedded');
  const input = panel.getByLabel('Message au coach');
  await input.fill('Ma séance : squats 3 × 8 à 60 kg');
  await panel.getByRole('button', { name: 'Retour à la page' }).tap();
  await page.getByRole('navigation', { name: 'Navigation mobile' }).getByRole('link', { name: 'Planning' }).tap();
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: 'Demander au coach' }).tap();
  await expect(input).toHaveValue('Ma séance : squats 3 × 8 à 60 kg');
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 360 });
    Object.defineProperty(window.visualViewport!, 'offsetTop', { configurable: true, value: 20 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  const bounds = (await panel.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(67);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(380);
  await expect(input).toHaveCSS('font-size', '16px');
  await expect(panel.getByRole('button', { name: 'Envoyer', exact: true })).toBeInViewport();
  await noOverflow(page);
  await page.screenshot({ path: `../.context/mobile-chiron-keyboard-${info.project.name}.png` });
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 844 });
    Object.defineProperty(window.visualViewport!, 'offsetTop', { configurable: true, value: 0 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await panel.getByRole('button', { name: 'Retour à la page' }).tap();
  await expect(launcher).toBeFocused();
  await expect(launcher).toBeInViewport();
  await page.reload();
  await launcher.tap();
  await expect(panel).toHaveAttribute('data-display', 'embedded');
  await expect(input).toHaveValue('Ma séance : squats 3 × 8 à 60 kg');
});

test('short viewport keeps planning and cardio forms reachable with keyboard and errors', async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/planning?new=1');
  await safeArea(page);
  let dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 320 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(47);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(320);
  await expect(dialog.getByLabel('Titre', { exact: true })).toHaveCSS('font-size', '16px');
  await dialog.getByRole('button', { name: 'Annuler', exact: true }).tap();
  await page.goto('/log?tab=cardio&new=1');
  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Séance sans montre' })).toBeVisible();
  await page.route('**/api/garmin/actual', route => route.fulfill({ status: 503, json: { detail: 'Indisponible' } }));
  await dialog.getByPlaceholder('Footing au parc').fill('Séance à conserver');
  await dialog.getByRole('button', { name: 'Enregistrer', exact: true }).tap();
  await expect(dialog.getByText(/Enregistrement impossible/)).toBeVisible();
  await expect(dialog.getByPlaceholder('Footing au parc')).toHaveValue('Séance à conserver');
  await noOverflow(page);
});


for (const [width, height] of [[375, 812], [844, 390]] as const) {
  test(`${width}x${height}: session entry and planning editor selects are 44 px touch targets matching their fields`, async ({ page }) => {
    await fixture(page);
    await page.setViewportSize({ width, height });
    await page.goto('/log?tab=cardio&new=1');
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Séance sans montre' })).toBeVisible();
    const date = (await dialog.getByLabel('Date', { exact: true }).boundingBox())!;
    const sport = (await dialog.locator('select').boundingBox())!;
    expect(sport.height).toBeGreaterThanOrEqual(44);
    expect(sport.height).toBeCloseTo(date.height, 0);
    // A phone stacks the date above the sport; a wider screen sets them side by side.
    if (width < 640) {
      expect(sport.y).toBeGreaterThan(date.y + date.height);
      expect(sport.x).toBeCloseTo(date.x, 0);
      expect(sport.width).toBeCloseTo(date.width, 0);
    } else expect(sport.y).toBeCloseTo(date.y, 0);
    await page.goto('/planning?new=1');
    dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const selects = await dialog.locator('select').all();
    expect(selects.length).toBeGreaterThan(0);
    for (const select of selects) expect((await select.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
}

/** A touch select: 44 px tall, the native look dropped for the shared drawn chevron. */
async function touchSelect(select: ReturnType<Page['locator']>) {
  await expect(select).toBeVisible();
  expect((await select.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const look = await select.evaluate(element => {
    const style = getComputedStyle(element);
    return { appearance: style.appearance || style.webkitAppearance, chevron: style.backgroundImage, fontSize: style.fontSize };
  });
  expect(look.appearance).toBe('none');
  expect(look.chevron).toContain('linear-gradient');
  // 16 px on a phone: iOS does not zoom into the field.
  expect(look.fontSize).toBe('16px');
}

test('375x812: settings, routine, watch and document selects are 44 px touch targets with the shared chevron', async ({ page }, info) => {
  const { createHash } = await import('node:crypto');
  await page.setViewportSize({ width: 375, height: 812 });
  await fixture(page);
  const session = { id: 42, revision: 1, date: '2026-10-20', sport: 'running', session_type: 'endurance', description: 'Footing de référence', source: 'coach', status: 'pending', prescription: { version: 1, steps: [{ kind: 'effort', duration_kind: 'seconds', value: 1800, steps: [] }] } };
  const original = Buffer.from('plan');
  const doc = { id: '11111111-1111-4111-8111-111111111111', name: 'Plan.xlsx', size: original.length, sha256: createHash('sha256').update(original).digest('hex'), status: 'ready' };
  // Registered after the fixture, so these answers come first; anything else falls back to it.
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/automations') return route.fulfill({ json: { items: [], next_offset: null } });
    if (path === '/api/coach/today') return route.fulfill({ json: { items: [], remaining: 0, briefing: null } });
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'disconnected' } });
    if (path.endsWith('/garmin/planned')) return route.fulfill({ json: [session] });
    if (path.endsWith('/42/workout')) return route.fulfill({ json: { session: { ...session, exportable: true, summary: '30 min' }, export: null } });
    if (path.endsWith('/workout-devices')) return route.fulfill({ json: [{ id: 10, name: 'fēnix 8', sports: ['running'], compatibility: 'documented' }] });
    if (path.endsWith('/documents')) return route.fulfill({ json: [doc] });
    if (path.endsWith('/extraction')) return route.fulfill({ json: { warnings: [], blocks: [{ locator: 'Semaine 1!A1', text: 'Footing 30 min', method: 'text', confidence: null }, { locator: 'Semaine 2!A1', text: 'Fractionné 6 × 400 m', method: 'text', confidence: null }] } });
    if (path.endsWith('/chunks/0')) return route.fulfill({ body: original, contentType: 'application/octet-stream' });
    return route.fallback();
  });

  await page.goto('/settings?tab=coach');
  await touchSelect(page.getByRole('combobox', { name: /À partir de/ }));
  await touchSelect(page.getByRole('combobox', { name: /Notifications de coaching par jour/ }));
  await page.getByRole('combobox', { name: /À partir de/ }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `../.context/are-180/settings-${info.project.name}.png` });

  await page.goto('/follow-up');
  await page.getByRole('button', { name: 'Routines', exact: true }).tap();
  await page.getByRole('button', { name: 'Créer une routine' }).tap();
  await touchSelect(page.getByLabel('Déclencheur', { exact: true }));
  await page.getByLabel('Déclencheur', { exact: true }).selectOption('session');
  await touchSelect(page.getByLabel('Séance', { exact: true }));
  // Their wrapping label names them with the chosen option: « Sport Tous ».
  for (const name of [/^Sport/, /^Type/]) await touchSelect(page.getByRole('combobox', { name }));
  await noOverflow(page);
  await page.screenshot({ path: `../.context/are-180/routine-${info.project.name}.png` });

  await page.clock.setFixedTime(new Date('2026-10-20T09:00:00'));
  await page.goto('/planning?date=2026-10-20');
  await page.getByRole('button', { name: 'Options du planning' }).tap();
  await page.getByRole('button', { name: 'Sélectionner', exact: true }).tap();
  const planning = page.getByRole('region', { name: 'Planning hebdomadaire' });
  await planning.getByLabel('Sélectionner Footing de référence').check();
  await planning.getByLabel('Demander aussi le transfert vers une montre').check();
  await touchSelect(planning.getByLabel('Montre Garmin'));
  await page.screenshot({ path: `../.context/are-180/watch-${info.project.name}.png` });

  await page.getByRole('button', { name: /^(Ouvrir le coach|Demander (?:au coach|à Chiron))$/ }).filter({ visible: true }).first().tap();
  await page.getByRole('button', { name: 'Fichiers du fil (1)' }).tap();
  await page.getByRole('button', { name: `Consulter ${doc.name}` }).tap();
  const preview = page.getByRole('dialog', { name: `Aperçu de ${doc.name}` });
  await touchSelect(preview.getByRole('combobox', { name: 'Page ou feuille du document' }));
  await preview.getByRole('combobox', { name: 'Page ou feuille du document' }).selectOption('Semaine 2');
  await expect(preview.getByText('Fractionné 6 × 400 m', { exact: true })).toBeVisible();
  await page.screenshot({ path: `../.context/are-180/document-${info.project.name}.png` });
});

test('touch page navigation preserves a live response and manual draft', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const stream = await coachStream(page, false, 'floating');
  try {
    await page.goto('/planning');
    await expect(page.getByRole('heading', { name: 'Planning', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Demander au coach' }).tap();
    const panel = page.getByRole('region', { name: 'Coach IA' });
    const input = panel.getByLabel('Message au coach');
    await input.fill('Comment adapter ma semaine ?');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).tap();
    await expect.poll(() => stream.requests()).toBe(1);
    stream.send({ type: 'token', id: 'answer', text: 'Préserve une journée de récupération.' });
    await expect(panel.locator('.coach-answer-part')).toContainText('Préserve une journée');
    await input.fill('Garde mon dimanche libre.');
    await panel.getByRole('button', { name: 'Retour à la page' }).tap();
    await page.getByRole('navigation', { name: 'Navigation mobile' }).getByRole('link', { name: 'Journal' }).tap();
    await expect(page.getByRole('heading', { name: 'Journal', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Le coach répond…' }).tap();
    await expect(input).toHaveValue('Garde mon dimanche libre.');
    await expect(panel).toHaveAttribute('data-display', 'embedded');
    await expect(input).toHaveValue('Garde mon dimanche libre.');
    stream.send({ type: 'token', id: 'answer', text: ' Dimanche reste libre.' });
    stream.send({ type: 'done', message: { role: 'assistant', content: 'Préserve une journée de récupération. Dimanche reste libre.' } });
    await expect(panel.getByRole('button', { name: 'Envoyer', exact: true })).toBeVisible();
    expect(stream.requests()).toBe(1);
    await noOverflow(page);
    await page.screenshot({ path: `../.context/mobile-chiron-live-${info.project.name}.png` });
  } finally { await stream.close(); }
});


test('landscape respects lateral safe areas and preserves the draft through rotation', async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto('/planning');
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--safe-left', '47px');
    document.documentElement.style.setProperty('--safe-right', '47px');
    document.documentElement.style.setProperty('--safe-bottom', '21px');
  });
  await expect(page.getByRole('heading', { name: 'Planning', exact: true })).toBeVisible();
  expect((await page.getByRole('link', { name: 'Arete · Accueil' }).boundingBox())!.x).toBeGreaterThanOrEqual(47);
  await page.getByRole('button', { name: 'Demander au coach' }).tap();
  const panel = page.getByRole('region', { name: 'Coach IA' });
  const input = panel.getByLabel('Message au coach');
  await input.fill('Brouillon en paysage');
  await expect(input).toHaveCSS('font-size', '16px');
  const box = (await panel.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(797);
  expect(box.y).toBeGreaterThanOrEqual(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await safeArea(page);
  await expect(input).toHaveValue('Brouillon en paysage');
  await noOverflow(page);
});

/** A finger drag made of raw touch events (Chromium only), kept inside the viewport.
 *  A positive distance moves the finger down, which scrolls towards the top (scrollTop
 *  decreases); the test asserts it. `Input.synthesizeScrollGesture` with a touch source
 *  does nothing in headless Chromium on Linux, so CI would never move anything. */
async function swipe(page: Page, x: number, y: number, yDistance: number) {
  const height = page.viewportSize()!.height;
  const at = (offset: number) => [{ x, y: Math.min(height - 1, Math.max(1, y + offset)) }];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
  for (let step = 1; step <= 10; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at((yDistance * step) / 10) });
  // Hold still before lifting: no fling outlives the gesture, so offsets read after it are final.
  await page.waitForTimeout(150);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(yDistance) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  // Let the compositor's scroll reach the page before anyone reads an offset.
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** The navigation or the inline page entry opens the same embedded conversation. */
const openCoach = (page: Page) => page.locator('button[aria-controls="coach-panel"]:visible').first().tap();

// ARE-155 opens Chiron from the launcher on a long conversation; ARE-156 lands on
// the onboarding recap through the same hand-off as the end of the onboarding.
for (const [width, height] of [[390, 844], [844, 390]] as const) for (const entry of ['launcher', 'onboarding'] as const) for (const mode of ['floating', 'sidebar'] as const) {
  test(`touch: a swipe in Chiron scrolls the conversation, never the page beneath (${width}x${height}, ${entry}, ${mode})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await fixture(page);
    const messages = Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Message ${i + 1}. ${'Une phrase pour allonger la conversation. '.repeat(4)}` }));
    await page.addInitScript(([display, seeded]) => {
      localStorage.setItem('arete.coach-display.v2', display);
      localStorage.setItem('arete.coach.threads.v1', JSON.stringify({ version: 1, activeId: 'long', threads: [{ id: 'long', title: 'Longue conversation', createdAt: 1, updatedAt: 1, messages: seeded, draft: 'Brouillon à garder' }] }));
    }, [mode, messages] as const);
    // Registered after the fixture's catch-all, so they answer first.
    await page.route('**/api/agent/conversations/*', route => route.request().method() === 'PUT'
      ? route.fulfill({ json: { revision: route.request().postDataJSON().revision + 1, title: 'Longue conversation' } })
      : route.fallback());
    await page.route('**/api/onboarding', route => route.fulfill({ json: { status: 'completed', revision: 1 } }));
    await page.route('**/api/onboarding/context', route => route.fulfill({ json: { revision: 1, forgotten: false, content: Array.from({ length: 30 }, (_, i) => `- Réponse ${i + 1} saisie pendant la configuration.`).join('\n') } }));
    const panel = page.getByRole('region', { name: 'Coach IA' });
    const thread = panel.locator('.coach-thread');
    const pageY = () => page.evaluate(() => scrollY);
    const threadTop = () => thread.evaluate(el => el.scrollTop);
    const chromium = info.project.name === 'mobile-chromium';
    if (entry === 'launcher') {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Tes repères' })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => window.scrollTo(0, 300));
      await expect.poll(pageY).toBe(300);
      await openCoach(page);
      await expect(panel.getByText(/^Message 24\./)).toBeInViewport();
    } else {
      await page.goto('/onboarding');
      await page.getByRole('button', { name: 'Ouvrir le coach' }).tap();
      await expect(page).toHaveURL(/\/coach$/);
      await expect(panel.getByRole('region', { name: 'Ton point de départ' })).toContainText('Réponse 30');
      await page.waitForLoadState('networkidle');
    }
    await expect(page).toHaveURL(/\/coach$/);
    await expect(panel).toHaveAttribute('data-display', 'embedded');
    await expect(panel).toHaveCSS('position', 'relative');
    const position = await pageY();
    // The thread is the bounded scroller: its content runs past the panel. Start mid-way,
    // whatever the recap or the follow mode left, so the first swipes have room both ways.
    expect(await thread.evaluate(el => el.scrollHeight > el.clientHeight + 200)).toBe(true);
    await thread.evaluate(el => { el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2); });
    const box = (await thread.boundingBox())!;
    const header = (await panel.locator('.coach-header').boundingBox())!;
    const composer = (await panel.locator('.coach-composer').boundingBox())!;
    if (chromium) {
      for (const pull of [100, -100]) {
        const before = await threadTop();
        await swipe(page, box.x + box.width / 2, box.y + box.height / 2, pull);
        await expect.poll(threadTop).not.toBe(before);
        expect(Math.sign(before - await threadTop())).toBe(Math.sign(pull));
        expect(await pageY()).toBe(position);
      }
      // From the composer or the header, nothing reaches the page.
      for (const [name, target] of [['composer', composer], ['header', header]] as const) for (const distance of [100, -100]) {
        await swipe(page, target.x + target.width / 3, target.y + target.height / 2, distance);
        expect(await pageY(), `${name} swipe ${distance}`).toBe(position);
      }
      // Nor past either end of the thread.
      for (const [edge, distance] of [['top', 100], ['bottom', -100]] as const) {
        await thread.evaluate((el, top) => { el.scrollTop = top ? 0 : el.scrollHeight; }, edge === 'top');
        await swipe(page, box.x + box.width / 2, box.y + box.height / 2, distance);
        expect(await pageY(), `thread ${edge} swipe ${distance}`).toBe(position);
      }
    } else {
      // Playwright cannot drag a finger in mobile WebKit: check what Safari honours instead.
      await expect(page.locator('html')).toHaveCSS('overflow-y', 'hidden');
      await expect(thread).toHaveCSS('overflow-y', 'auto');
      await expect(thread).toHaveCSS('overscroll-behavior-y', 'contain');
    }
    await panel.getByRole('button', { name: 'Retour à la page' }).tap();
    await expect(panel).toBeHidden();
    await expect(page.locator('html')).not.toHaveCSS('overflow-y', 'hidden');
    if (chromium) {
      await swipe(page, width / 4, height * 0.6, -150);
      await expect.poll(pageY).toBeGreaterThan(0);
    }
    // The conversation and its draft survive the round trip.
    await openCoach(page);
    if (entry === 'launcher') await expect(panel.getByLabel('Message au coach')).toHaveValue('Brouillon à garder');
    else await expect(panel.getByRole('region', { name: 'Ton point de départ' })).toBeVisible();
  });
}

// ARE-164: the Garmin notice above the bar pushes the navigation down; the panel follows it.
for (const [width, height] of [[844, 390], [1280, 800]] as const) for (const notice of [true, false]) for (const mode of ['floating', 'sidebar'] as const) {
  test(`${width}x${height}: Chiron starts below the navigation (${notice ? 'with' : 'without'} the Garmin notice, ${mode})`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await fixture(page);
    // A long conversation keeps the embedded thread bounded below the navigation.
    const messages = Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Message ${i + 1}. ${'Une phrase pour allonger la conversation. '.repeat(4)}` }));
    await page.addInitScript(([display, seeded]) => {
      localStorage.setItem('arete.coach-display.v2', display);
      localStorage.setItem('arete.coach.threads.v1', JSON.stringify({ version: 1, activeId: 'long', threads: [{ id: 'long', title: 'Longue conversation', createdAt: 1, updatedAt: 1, messages: seeded }] }));
    }, [mode, messages] as const);
    if (!notice) await page.route('**/api/garmin/sync/ensure', route => route.fulfill({ json: { state: 'fresh' } }));
    const ensured = page.waitForResponse('**/api/garmin/sync/ensure');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Tes repères' })).toBeVisible();
    await ensured;
    const status = page.getByRole('status').filter({ hasText: 'Garmin' });
    if (notice) await expect(status).toBeVisible();
    else await expect(status).toHaveCount(0);
    const nav = page.getByRole('navigation', { name: 'Navigation principale' });
    const panel = page.getByRole('region', { name: 'Coach IA' });
    const close = panel.getByRole('button', { name: 'Retour à la page' });
    const navBottom = async () => { const bar = (await nav.boundingBox())!; return bar.y + bar.height; };
    const headerGap = async () => (await panel.boundingBox())!.y - await navBottom();
    const belowNavigation = async () => {
      await expect.poll(headerGap).toBeGreaterThanOrEqual(-0.5);
      await expect.poll(headerGap).toBeLessThanOrEqual(width >= 1024 ? 48 : 24);
    };
    await openCoach(page);
    await expect(panel).toHaveAttribute('data-display', 'embedded');
    const top = await navBottom();
    expect(top).toBeGreaterThan(notice ? 80 : 50);
    await belowNavigation();
    // Nothing covers the close button: a tap at its centre lands on it.
    const box = (await close.boundingBox())!;
    expect(await close.evaluate((button, [x, y]) => button.contains(document.elementFromPoint(x, y)), [box.x + box.width / 2, box.y + box.height / 2])).toBe(true);
    await close.tap();
    await expect(panel).toBeHidden();
  });
}

// The upright phone layout ends at 767 px; a wider, taller touch screen keeps a scrollable page.
for (const [width, locked] of [[767, true], [768, false], [1024, false]] as const) {
  test(`${width} px: the open coach ${locked ? 'holds' : 'leaves'} the page beneath`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await fixture(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Tes repères' })).toBeVisible();
    await openCoach(page);
    await expect(page.getByRole('region', { name: 'Coach IA' })).toBeVisible();
    if (locked) await expect(page.locator('html')).toHaveCSS('overflow-y', 'hidden');
    else await expect(page.locator('html')).not.toHaveCSS('overflow-y', 'hidden');
  });
}

/** The control fits its dialog and the page does not scroll sideways. */
async function fitsDialog(page: Page, control: ReturnType<Page['getByLabel']>) {
  // Measure the settled dialog, not its entrance.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
    .map((animation) => animation.finished)));
  const dialog = (await page.getByRole('dialog').boundingBox())!;
  const box = (await control.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(dialog.x);
  expect(box.x + box.width).toBeLessThanOrEqual(dialog.x + dialog.width);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await control.evaluate((input) => input.scrollWidth <= input.clientWidth)).toBe(true);
  await noOverflow(page);
}

test('touch: closing the session entry opened from Home returns Home, and its date fits', async ({ page }, info) => {
  await page.clock.setFixedTime(new Date('2026-10-15T19:00:00'));
  await page.setViewportSize({ width: 375, height: 812 });
  await fixture(page);
  await page.goto('/');
  await safeArea(page);
  const briefing = page.getByRole('heading', { name: 'Tes repères' });
  await expect(briefing).toBeVisible();
  await page.getByRole('link', { name: 'Saisir une séance', exact: true }).tap();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Saisir une séance' })).toBeVisible();
  const date = dialog.getByLabel('Date', { exact: true });
  await expect(date).toHaveValue('2026-10-15');
  await fitsDialog(page, date);
  await page.screenshot({ path: `../.context/are-159/session-entry-375-${info.project.name}.png` });
  await page.setViewportSize({ width: 320, height: 640 });
  await fitsDialog(page, date);
  await page.screenshot({ path: `../.context/are-159/session-entry-320-${info.project.name}.png` });
  await date.fill('2026-10-12');
  await expect(date).toHaveValue('2026-10-12');

  await dialog.getByRole('button', { name: 'Fermer', exact: true }).tap();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/$/);
  await expect(briefing).toBeVisible();

  // Without a page before it (a link opened in a new tab), closing lands on Home too.
  await page.goto('/log?tab=cardio&new=1');
  await expect(dialog.getByRole('heading', { name: 'Séance sans montre' })).toBeVisible();
  await fitsDialog(page, dialog.getByLabel('Date', { exact: true }));
  await dialog.getByRole('button', { name: 'Fermer', exact: true }).tap();
  await expect(page).toHaveURL(/\/$/);
  await expect(briefing).toBeVisible();

  // Opened by the Journal itself, the entry closes in place.
  await page.getByRole('navigation', { name: 'Navigation mobile' }).getByRole('link', { name: 'Journal', exact: true }).tap();
  const journal = page.getByRole('heading', { name: 'Journal', exact: true });
  await expect(journal).toBeVisible();
  await page.getByRole('button', { name: 'Saisir une séance', exact: true }).tap();
  await expect(dialog.getByRole('heading', { name: 'Saisir une séance' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Fermer', exact: true }).tap();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/log$/);
  await expect(journal).toBeVisible();
});

test('touch: the morning check-in is three taps at 375 px and then gives the page back', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await fixture(page);
  const answers: unknown[] = [];
  let answered: Record<string, unknown> | null = null;
  // Registered after the fixture's catch-all, so they answer first.
  await page.route('**/api/checkins/*', (route) => {
    const body = route.request().postDataJSON();
    answers.push(body);
    const at = '2026-10-15T05:12:00+00:00';
    const date = new URL(route.request().url()).pathname.split('/').pop();
    answered = { date, ...body, answered_at: at, updated_at: at };
    return route.fulfill({ json: { ...answered, replanned: false } });
  });
  // The dashboard read again after the answer carries it.
  await page.route('**/api/dashboard', (route) => route.fulfill({ json: dashboardAnswer({ checkin: answered }) }));
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Check-in du matin' });
  await expect(card).toBeVisible();
  await noOverflow(page);
  await card.getByRole('radio', { name: '4 sur 5 — bon', exact: true }).tap();
  await card.getByRole('radio', { name: '1 sur 5 — très lourdes', exact: true }).tap();
  await card.getByRole('button', { name: 'Valider' }).tap();
  await expect(card).toBeHidden();
  expect(answers).toEqual([{ sleep: 4, legs: 1, mood: null, note: null }]);
  await page.waitForLoadState('networkidle');
  await expect(card).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Briefing du jour' })).toBeInViewport();
});

test('touch: a Garmin strength session gets its loads from the Journal in four interactions at 375 px', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-15T19:00:00'));
  await page.setViewportSize({ width: 375, height: 812 });
  await fixture(page);
  const draft = {
    id: 7, actual_session_id: 41, date: '2026-10-15', name: 'Musculation', duration_min: 52, origin: 'import',
    exercises: [
      { name: 'Développé couché', exercise_id: 'bench_press', sets: 3, reps: 10 },
      { name: 'Squat', exercise_id: 'back_squat', sets: 5, reps: 5 },
    ],
    notation: 'Développé couché 3x10\nSquat 5x5',
  };
  let completed = false;
  const completions: unknown[] = [];
  const parsed = {
    success: true, date: draft.date, name: null, duration_min: null, overall_rpe: null, notes: null,
    session_id: null, message: null, unparsed_lines: [], records: [],
    exercises: [
      { name: 'Développé couché', exercise_id: 'bench_press', exercise_matched: true, notes: null, match_score: 100, suggestions: [],
        sets: [1, 2, 3].map((n) => ({ set_number: n, reps: 10, weight_kg: 80, is_warmup: false, is_failure: false })) },
      { name: 'Squat', exercise_id: 'back_squat', exercise_matched: true, notes: null, match_score: 100, suggestions: [],
        sets: [1, 2, 3, 4, 5].map((n) => ({ set_number: n, reps: 5, weight_kg: 100, is_warmup: false, is_failure: false })) },
    ],
  };
  // Registered after the fixture's catch-all, so they answer first.
  const answered = new Set(['/api/garmin/sync/ensure', '/api/coach/today', '/api/strength/drafts', '/api/strength/drafts/7/complete', '/api/strength/sessions/parse', '/api/tips/post-session']);
  await page.route((url) => answered.has(url.pathname), (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'fresh' } });
    if (path === '/api/coach/today') return route.fulfill({ json: { items: [], remaining: 0, briefing: null } });
    if (path === '/api/strength/drafts') return route.fulfill({ json: completed ? { items: [], total: 0 } : { items: [draft], total: 1 } });
    if (path === '/api/strength/sessions/parse') return route.fulfill({ json: parsed });
    if (path === '/api/tips/post-session') return route.fulfill({ json: { feedback: 'Belle séance.', highlights: [], source: 'rules' } });
    completions.push(route.request().postDataJSON());
    completed = true;
    return route.fulfill({
      json: {
        session_id: 90, message: 'Séance complétée : 2 exercice(s)', unparsed_lines: [], dropped: [],
        records: [{ exercise_id: 3, exercise: 'Développé couché', kind: 'weight', value: 80, previous: 75, weight_kg: 80, reps: 10, date: draft.date }],
      },
    });
  });
  await page.goto('/log');
  const drafts = page.getByRole('region', { name: 'À compléter (1)' });
  await expect(drafts).toBeVisible();
  await expect(drafts.getByText('Développé couché · Squat')).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: '../.context/are-132/journal-draft-mobile.png', animations: 'disabled' });

  await drafts.getByRole('button', { name: 'Ajoute tes charges' }).tap(); // 1
  const dialog = page.getByRole('dialog');
  const text = dialog.getByRole('textbox', { name: 'Séance en texte libre' });
  await expect(text).toHaveValue(draft.notation);
  await expect(dialog.getByLabel('Date')).toHaveCount(0);
  await noOverflow(page);
  await page.screenshot({ path: '../.context/are-132/completion-mobile.png', animations: 'disabled' });
  await text.fill('Développé couché 3x10@80\nSquat 5x5@100'); // 2
  await dialog.getByRole('button', { name: 'Analyser' }).tap(); // 3
  await dialog.getByRole('button', { name: 'Enregistrer' }).tap(); // 4

  await expect(dialog.getByText('Séance enregistrée')).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'Nouveaux records' })).toBeVisible();
  expect(completions).toEqual([{ text: 'Développé couché 3x10@80\nSquat 5x5@100' }]);
  await page.screenshot({ path: '../.context/are-132/completed-mobile.png', animations: 'disabled' });
  // The completed draft leaves the list; its screen stays until closed.
  await expect(drafts).toBeHidden();
  // The header's close icon shares the name: tap the closing action under the result.
  await dialog.getByRole('button', { name: 'Fermer', exact: true }).last().tap();
  await expect(page).toHaveURL(/\/log$/);
});
