import { test, expect, type Page } from '@playwright/test';
import { coachStream as fixture } from './coachStream';


async function openCoach(page: Page) {
  await page.goto('/planning?date=2026-10-10');
  const toggle = page.getByRole('button', { name: /^(Ouvrir le coach|Demander (?:au coach|à Chiron))$/ }).filter({ visible: true }).first();
  await toggle.click();
  const panel = page.getByRole('region', { name: 'Coach IA' });
  await expect(panel).toHaveCSS('opacity', '1');
  return panel;
}

const preview = { text: '{}', truncated: false };

test('Chiron composer: inline file picker, draft removal and reuse before sending', async ({ page }) => {
  const stream = await fixture(page);
  const doc = { id: '11111111-1111-4111-8111-111111111111', name: 'Programme semaine 42.md', size: 18, sha256: '0'.repeat(64), status: 'ready' };
  let uploaded = false;
  let deleted = false;
  await page.route('**/api/agent/threads/*/documents**', route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'DELETE') { deleted = true; uploaded = false; return route.fulfill({ json: {} }); }
    if (path.endsWith('/finalize')) { uploaded = true; return route.fulfill({ json: doc }); }
    if (path.includes('/chunks/')) return route.fulfill({ json: { uploaded: true } });
    if (route.request().method() === 'POST') return route.fulfill({ json: doc });
    return route.fulfill({ json: uploaded ? [doc] : [] });
  });
  try {
    const panel = await openCoach(page);
    await page.evaluate(() => document.documentElement.dataset.theme = 'pierre');
    const composer = panel.locator('footer');
    const attach = composer.getByRole('button', { name: 'Joindre un fichier', exact: true });
    await expect(attach).toBeVisible();
    await expect(composer.getByRole('button', { name: /Fichiers du fil/ })).toHaveCount(0);
    await composer.getByLabel('Message au coach').fill('Adapte ce programme à ma semaine.');
    // The add action must sit beside the text, never in a separate toolbar.
    const expectInlineAttachment = async () => {
      const button = await attach.boundingBox();
      const input = await composer.getByLabel('Message au coach').boundingBox();
      expect(button).not.toBeNull();
      expect(input).not.toBeNull();
      expect(button!.x + button!.width).toBeLessThanOrEqual(input!.x);
      expect(button!.y).toBeGreaterThanOrEqual(input!.y);
      expect(button!.y + button!.height).toBeLessThanOrEqual(input!.y + input!.height + 1);
    };
    await expectInlineAttachment();
    await page.screenshot({ path: '../.context/chiron-composer-desktop.png' });
    await composer.screenshot({ path: '../.context/chiron-composer-detail.png' });
    const picker = page.waitForEvent('filechooser');
    await attach.click();
    await (await picker).setFiles({ name: doc.name, mimeType: 'text/markdown', buffer: Buffer.from('Footing 30 minutes') });
    const library = composer.getByRole('button', { name: 'Fichiers du fil (1)' });
    await expect(library).toHaveText('1');
    await expect(composer.getByRole('button', { name: `Consulter ${doc.name}` })).toHaveCount(0);
    const inlineHeight = (await composer.boundingBox())!.height;
    await library.click();
    await expect(composer.getByRole('button', { name: `Consulter ${doc.name}` })).toBeVisible();
    expect((await composer.boundingBox())!.height).toBe(inlineHeight);
    expect(stream.requests()).toBe(0);
    await composer.getByRole('checkbox', { name: doc.name }).uncheck();
    await expect(library).toHaveText('');
    expect(deleted).toBe(false);
    await composer.getByRole('checkbox', { name: doc.name }).check();
    await page.keyboard.press('Escape');
    await expect(library).toBeFocused();
    await expect(library).toHaveText('1');
    await expect(composer.getByRole('button', { name: `Consulter ${doc.name}` })).toHaveCount(0);
    await expect(composer.getByLabel('Message au coach')).toHaveValue('Adapte ce programme à ma semaine.');
    for (const theme of ['pierre', 'prune']) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
      await expect(attach).toBeInViewport();
      await expect(composer.getByRole('button', { name: 'Envoyer', exact: true })).toBeInViewport();
      expect(await composer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expectInlineAttachment();
      const inputBounds = (await composer.getByLabel('Message au coach').boundingBox())!;
      const fileBounds = (await library.boundingBox())!;
      expect(fileBounds.y + fileBounds.height).toBe(inputBounds.y + inputBounds.height);
      await page.screenshot({ path: `../.context/chiron-composer-${theme}-mobile.png` });
    }
    await composer.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect.poll(() => stream.requests()).toBe(1);
    await expect(attach).toBeDisabled();
    await expect(panel.getByRole('article', { name: 'Ton message' }).getByText(doc.name)).toBeVisible();
    await composer.getByRole('button', { name: 'Arrêter la réponse' }).click();
    await expect(attach).toBeEnabled();
    await library.click();
    await composer.getByRole('button', { name: `Supprimer définitivement ${doc.name}` }).click();
    await expect(library).toHaveCount(0);
    await expect(composer.getByRole('checkbox')).toHaveCount(0);
    expect(deleted).toBe(true);
  } finally { await stream.close(); }
});

test('Chiron: real SSE states, one motion cycle, immediate text and an interrupted write without replay', async ({ page }) => {
  const stream = await fixture(page);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openCoach(page);
    await panel.getByLabel('Message au coach').fill('Supprime mon ancien objectif 10 km de mes notes.');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('Chiron prépare sa réponse');
    await expect(panel.locator('.coach-activity details')).not.toHaveAttribute('open');
    // Sample the actual orbit over a full 1.4 s turn; the laurel never rotates.
    const frames = await panel.locator('.activity-orbit').evaluate(element => {
      const animation = element.getAnimations()[0];
      animation.pause();
      const result = [0, 350, 700, 1400].map(time => {
        animation.currentTime = time;
        return getComputedStyle(element).transform;
      });
      animation.play();
      return result;
    });
    expect(new Set(frames.slice(0, 3)).size).toBe(3);
    // While Chiron thinks, its one laurel turns in the status line, still itself,
    // and the message has no header yet (ARE-6).
    const answer = panel.locator('.coach-activity').locator('xpath=..');
    await expect(panel.locator('.activity-presence .arete-mark')).toHaveCSS('transform', 'none');
    await expect(answer.locator('.arete-mark')).toHaveCount(1);
    await expect(answer.getByText('CHIRON', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: '../.context/chiron-latency-desktop.png', animations: 'disabled' });
    stream.send({ type: 'tool_start', id: 'read', name: 'read_file', args: preview });
    await expect(panel.getByRole('status')).toHaveText('Lecture d’un fichier');
    stream.send({ type: 'tool_end', id: 'read', name: 'read_file', status: 'done', output: preview, elapsed_ms: 40 });
    await expect(panel.getByRole('status')).toHaveText('Fichier consulté · préparation de la réponse');
    await expect(panel.locator('.activity-orbit')).toBeVisible();
    stream.send({ type: 'token', id: 'answer', text: 'J’ai retrouvé ton ancien objectif.' });
    await expect(panel.getByText('J’ai retrouvé ton ancien objectif.', { exact: true })).toBeVisible({ timeout: 1_000 });
    // From the first word on, the header names Chiron and the status keeps no laurel.
    await expect(answer.getByText('CHIRON', { exact: true })).toBeVisible();
    await expect(answer.locator('.arete-mark')).toHaveCount(1);
    await expect(panel.locator('.coach-activity .arete-mark')).toHaveCount(0);
    await expect(panel.locator('.activity-orbit')).toHaveCount(0);
    await expect(panel.getByRole('status')).toHaveText('Réponse en cours');
    const prose = await panel.locator('.coach-answer-part').elementHandle();
    stream.send({ type: 'token', id: 'answer', text: ' Je mets les notes à jour.' });
    await expect(panel.locator('.coach-answer-part')).toContainText('Je mets les notes à jour.');
    expect(await prose!.evaluate(node => node === document.querySelector('.coach-answer-part'))).toBe(true);
    const measures = await page.evaluate(() => performance.getEntriesByType('measure').map(entry => entry.name));
    expect(measures.filter(name => name === 'coach:time-to-feedback')).toHaveLength(1);
    expect(measures.filter(name => name === 'coach:time-to-first-text')).toHaveLength(1);
    stream.send({ type: 'tool_start', id: 'edit', name: 'edit_file', args: preview });
    await expect(panel.getByRole('status')).toHaveText('Mise à jour de tes notes');
    await panel.getByLabel('Message au coach').fill('Mon prochain message');
    await panel.getByRole('button', { name: 'Arrêter la réponse' }).click();
    await expect(panel.getByRole('status')).toHaveText('Réponse interrompue');
    await expect(panel.getByText(/Une action a peut-être déjà été effectuée/)).toBeVisible();
    await expect(panel.getByLabel('Message au coach')).toHaveValue('Mon prochain message');
    await expect(panel.getByRole('button', { name: /Réessayer|Regénérer/ })).toHaveCount(0);
    expect(stream.requests()).toBe(1);
  } finally { await stream.close(); }
});

for (const theme of ['pierre', 'prune']) {
  test(`mobile ${theme}: reduced motion, stable layout and confirmed result`, async ({ page }) => {
    const stream = await fixture(page);
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const panel = await openCoach(page);
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
      await panel.getByLabel('Message au coach').fill('Mets à jour mes notes.');
      await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
      await expect(panel.getByRole('status')).toHaveText('Chiron prépare sa réponse');
      await expect(panel.locator('.activity-orbit')).toHaveCSS('animation-name', 'none');
      stream.send({ type: 'tool_start', id: 'edit', name: 'edit_file', args: preview });
      stream.send({ type: 'tool_end', id: 'edit', name: 'edit_file', status: 'done', output: preview, elapsed_ms: 40 });
      await expect(panel.getByRole('status')).toHaveText('Notes mises à jour · préparation de la réponse');
      await expect(panel.locator('.coach-confirmation')).toHaveCount(0);
      stream.send({ type: 'token', id: 'answer', text: 'Tes notes sont à jour.' });
      stream.send({ type: 'done', message: { role: 'assistant', content: 'Tes notes sont à jour.' } });
      await expect(panel.getByText('Tes notes sont à jour.', { exact: true })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Envoyer', exact: true })).toBeVisible();
      const overflowing = await panel.evaluate(element => Array.from(element.querySelectorAll('.coach-activity, .coach-answer-part, textarea, footer')).filter(child => {
        const bounds = child.getBoundingClientRect();
        return bounds.left < 0 || bounds.right > innerWidth || child.scrollWidth > child.clientWidth + 1;
      }).map(child => child.className));
      expect(overflowing).toEqual([]);
      await expect(panel.getByRole('img')).toHaveCount(0); // Decorative avatar remains hidden to screen readers.
      const mark = panel.locator('header .arete-mark');
      await expect(mark).toHaveCSS('width', '24px');
      await expect(mark).toHaveCSS('height', '24px');
      await expect(mark).toHaveCSS('mask-image', /url\(/);
      await expect(panel.locator('.coach-confirmation')).toHaveCSS('animation-name', 'none');
      await page.screenshot({ path: `../.context/chiron-latency-${theme}-mobile.png`, animations: 'disabled' });
      expect(stream.requests()).toBe(1);
    } finally { await stream.close(); }
  });
}

test('the existing opt-out keeps its composer and uses the shared coach presence', async ({ page }) => {
  const stream = await fixture(page, false);
  try {
    const panel = await openCoach(page);
    await expect(panel.getByRole('heading', { name: 'Coach', exact: true })).toBeVisible();
    await panel.getByLabel('Message au coach').fill('Ma forme ?');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect(panel.locator('.activity-presence')).toBeVisible();
    await expect(panel.getByText('Voir l’activité')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Arrêter la réponse' })).toBeVisible();
  } finally { await stream.close(); }
});

for (const theme of ['pierre', 'prune']) {
  test(`compact ${theme} composer preserves newlines and scrolls only vertically`, async ({ page }) => {
    const stream = await fixture(page);
    const doc = { id: '11111111-1111-4111-8111-111111111111', name: 'Programme.md', size: 18, sha256: '0'.repeat(64), status: 'ready' };
    await page.route('**/api/agent/threads/*/documents', route => route.fulfill({ json: [doc] }));
    try {
      const panel = await openCoach(page);
        await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
      const composer = panel.locator('footer');
      const input = composer.getByLabel('Message au coach');
      const library = composer.getByRole('button', { name: 'Fichiers du fil (1)' });
      await expect(library).toBeVisible();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await input.fill('Première ligne');
        await input.press('Shift+Enter');
        await input.pressSequentially('Deuxième ligne');
        await expect(input).toHaveValue('Première ligne\nDeuxième ligne');
        expect(stream.requests()).toBe(0);
        await input.fill(('Une longue ligne qui doit rester dans le champ. '.repeat(10) + '\n' + 'x'.repeat(200) + '\n').repeat(8));
        const dimensions = await input.evaluate(el => ({ width: el.clientWidth, contentWidth: el.scrollWidth, height: el.clientHeight, contentHeight: el.scrollHeight }));
        expect(dimensions.height).toBeLessThanOrEqual(144);
        expect(dimensions.contentHeight).toBeGreaterThan(dimensions.height);
        expect(dimensions.contentWidth).toBeLessThanOrEqual(dimensions.width);
        await expect(input).toHaveCSS('overflow-x', 'hidden');
        await expect(input).toHaveCSS('overflow-y', 'auto');
        await composer.screenshot({ path: `../.context/composer-${theme}-${width}-multiline.png` });
        await input.fill('');
        await expect(input).toHaveCSS('overflow-y', 'hidden');
        // The archived-file count must not reserve a second row in an empty draft.
        expect((await composer.locator('.coach-composer').boundingBox())!.height).toBeLessThan(84);
        const inputBox = (await input.boundingBox())!;
        const libraryBox = (await library.boundingBox())!;
        expect(libraryBox.y).toBeGreaterThanOrEqual(inputBox.y);
        expect(libraryBox.y + libraryBox.height).toBeLessThanOrEqual(inputBox.y + inputBox.height + 1);
        expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await composer.screenshot({ path: `../.context/composer-${theme}-${width}-empty.png` });
      }
    } finally { await stream.close(); }
  });
}


test('Arete: file drop, inline draft and active SSE survive tab navigation', async ({ page }) => {
  const stream = await fixture(page);
  const doc = { id: '11111111-1111-4111-8111-111111111111', name: 'Plan.md', size: 18, sha256: '0'.repeat(64), status: 'ready' };
  let uploaded = false;
  await page.route('**/api/agent/threads/*/documents**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/finalize')) { uploaded = true; return route.fulfill({ json: doc }); }
    if (path.includes('/chunks/')) return route.fulfill({ json: { uploaded: true } });
    if (route.request().method() === 'POST') return route.fulfill({ json: doc });
    return route.fulfill({ json: uploaded ? [doc] : [] });
  });
  try {
    const panel = await openCoach(page);
    const input = panel.getByLabel('Message au coach');
    await input.fill('Adapte ma semaine avec ce fichier.');
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(['Footing 30 minutes'], 'Plan.md', { type: 'text/markdown' }));
      return data;
    });
    await panel.dispatchEvent('dragenter', { dataTransfer: transfer });
    await expect(panel.getByText('Dépose tes fichiers ici')).toBeVisible();
    await panel.dispatchEvent('drop', { dataTransfer: transfer });
    await expect(panel.getByText('Dépose tes fichiers ici')).toHaveCount(0);
    await expect(panel.locator('footer').getByRole('button', { name: 'Fichiers du fil (1)' })).toHaveText('1');
    expect(stream.requests()).toBe(0);
    const navigation = page.getByRole('navigation', { name: 'Navigation principale' });
    await navigation.getByRole('link', { name: 'Réglages', exact: true }).click();
    await expect(page).toHaveURL(/settings/);
    await navigation.getByRole('button', { name: 'Ouvrir le coach' }).click();
    await expect(input).toHaveValue('Adapte ma semaine avec ce fichier.');
    await expect(panel.locator('footer').getByRole('button', { name: 'Fichiers du fil (1)' })).toHaveText('1');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect.poll(() => stream.requests()).toBe(1);
    stream.send({ type: 'tool_start', id: 'planning', name: 'read_file', args: preview });
    await input.fill('Garde mon dimanche libre.');
    await navigation.getByRole('link', { name: 'Planning', exact: true }).click();
    await expect(page).toHaveURL(/planning/);
    await navigation.getByRole('button', { name: 'Ouvrir le coach' }).click();
    await expect(panel.getByRole('status')).toHaveText('Lecture d’un fichier');
    await expect(input).toHaveValue('Garde mon dimanche libre.');
    stream.send({ type: 'tool_end', id: 'planning', name: 'read_file', status: 'done', output: preview, elapsed_ms: 80 });
    await expect(panel.locator('.activity-orbit')).toBeVisible();
    stream.send({ type: 'token', id: 'answer', text: 'Voici les ajustements proposés.' });
    await expect(panel.getByText('Voici les ajustements proposés.', { exact: true })).toBeVisible();
    await expect(panel.locator('.activity-orbit')).toHaveCount(0);
    stream.send({ type: 'done', message: { role: 'assistant', content: 'Voici les ajustements proposés.' } });
    await expect(panel.getByRole('button', { name: 'Envoyer', exact: true })).toBeEnabled();
    stream.send({ type: 'suggestion', text: 'Une autre suggestion' });
    await expect(input).toHaveValue('Garde mon dimanche libre.');
    expect(stream.requests()).toBe(1);
    await page.screenshot({ path: '../.context/arete-brand/verified-navigation.png', animations: 'disabled' });
  } finally { await stream.close(); }
});

test('classic coach: one memory receipt, inline files, drafts and reload', async ({ page }) => {
  const stream = await fixture(page, false);
  const fact = { id: 12, kind: 'preference', text: 'Je préfère courir le matin', since: '2026-10-11', source: 'coach', source_ref: 'Déclaration dans cette conversation', status: 'active', evidence: 'explicit', revision: 1, valid_until: null };
  await page.route('**/api/athlete-facts', route => route.fulfill({ json: [fact] }));
  try {
    const panel = await openCoach(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.dataset.theme = 'prune');
    await expect(panel.getByRole('region', { name: 'Documents du coach' })).toHaveCount(0);
    await expect(panel.locator('footer').getByRole('button', { name: 'Joindre un fichier', exact: true })).toBeVisible();
    await panel.getByLabel('Message au coach').fill('Je préfère courir le matin.');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect.poll(() => stream.requests()).toBe(1);
    stream.send({ type: 'tool_start', id: 'save', name: 'remember_fact', args: preview });
    stream.send({ type: 'tool_end', id: 'save', name: 'remember_fact', status: 'done', output: preview, elapsed_ms: 20 });
    for (let i = 0; i < 2; i++) stream.send({ type: 'coach_card', id: 'fact:12', ref_kind: 'fact', ref_id: 12 });
    stream.send({ type: 'message', id: 'answer', text: 'D’accord, je privilégierai le matin pour tes séances.' });
    stream.send({ type: 'done', message: { role: 'assistant', content: 'D’accord, je privilégierai le matin pour tes séances.' } });
    const receipt = panel.getByRole('button', { name: 'Voir la mémoire mise à jour' });
    await expect(receipt).toHaveCount(1);
    await expect(receipt).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.getByRole('status')).toHaveCount(0);
    await expect(panel.getByText('RETENU', { exact: true })).toHaveCount(0);
    await panel.getByLabel('Message au coach').fill('Mon brouillon');
    await panel.getByRole('button', { name: 'Options du coach' }).click();
    await panel.getByRole('button', { name: 'Ce que le coach sait de moi' }).click();
    await expect(panel.getByText('Ce que je retiens de toi')).toBeVisible();
    await expect(panel.getByLabel('Nouveau fait')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Options du coach' }).click();
    await panel.getByRole('button', { name: 'Ce que le coach sait de moi' }).click();
    await expect(panel.getByLabel('Message au coach')).toHaveValue('Mon brouillon');
    expect(stream.requests()).toBe(1);
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: '../.context/chiron-inline-local-mobile.png' });
    await expect.poll(() => page.evaluate(() => Object.values(localStorage).some(v => v.includes('Mon brouillon')))).toBe(true);
    // Hold bootstrap so reload coverage cannot depend on a fast local render.
    let releaseBootstrap!: () => void;
    const bootstrap = new Promise<void>(resolve => { releaseBootstrap = resolve; });
    await page.route('**/api/auth/config', async route => {
      await bootstrap;
      await route.fulfill({ json: { enabled: false } });
    });
    await page.reload();
    releaseBootstrap();
    await expect(page).toHaveURL(/\/coach$/);
    await expect(receipt).toHaveCount(1);
    await receipt.click();
    const saved = panel.locator('summary').filter({ hasText: fact.text });
    await expect(saved).toBeVisible();
    await saved.click();
    await expect(panel.getByRole('button', { name: 'Corriger', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Résolu', exact: true })).toHaveCount(0);
    expect(stream.requests()).toBe(1);
  } finally { await stream.close(); }
});

test('embedded chat bounds its scroller and respects reading older messages during SSE', async ({ page }) => {
  const stream = await fixture(page);
  try {
    const panel = await openCoach(page);
    await expect(panel).toHaveAttribute('data-display', 'embedded');
    expect((await panel.boundingBox())!.width).toBe(1296);
    await expect(page.locator('main')).toHaveCSS('margin-right', '0px');
    await page.screenshot({ path: '../.context/chiron-embedded-empty-app.png' });
    const input = panel.getByLabel('Message au coach');
    await input.fill('Détaille ma semaine');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect.poll(() => stream.requests()).toBe(1);
    const heights: number[] = [];
    let text = '';
    for (let i = 0; i < 12; i++) {
      const chunk = `Étape ${i + 1} : ${"Garde cette séance en endurance confortable, puis prévois une journée de récupération. ".repeat(4)}\n\n`;
      text += chunk;
      stream.send({ type: 'token', id: 'answer', text: chunk });
      await expect(panel.locator('.coach-answer-part')).toContainText(`Étape ${i + 1}`);
      const box = (await panel.boundingBox())!;
      heights.push(Math.round(box.height));
      expect(box.y + box.height).toBeLessThanOrEqual(1100);
    }
    expect(new Set(heights).size).toBe(1);
    const thread = panel.locator('.coach-thread');
    await expect.poll(() => thread.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
    await thread.evaluate(el => { el.scrollTop = 0; });
    await expect(panel.getByRole('button', { name: 'Derniers messages' })).toBeVisible();
    stream.send({ type: 'token', id: 'answer', text: 'Une dernière précision.' });
    await expect(panel.locator('.coach-answer-part')).toContainText('Une dernière précision.');
    expect(await thread.evaluate(el => el.scrollTop)).toBe(0);
    await panel.getByRole('button', { name: 'Derniers messages' }).click();
    await expect.poll(() => thread.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
    stream.send({ type: 'done', message: { role: 'assistant', content: text + 'Une dernière précision.' } });
    await expect(panel.getByRole('button', { name: 'Envoyer', exact: true })).toBeVisible();
    await page.screenshot({ path: '../.context/chiron-embedded-growth-app.png' });
  } finally { await stream.close(); }
});

test('page round trips preserve a live stream, draft and files', async ({ page }) => {
  const stream = await fixture(page);
  const doc = { id: '11111111-1111-4111-8111-111111111111', name: 'Plan.md', size: 18, sha256: '0'.repeat(64), status: 'ready' };
  await page.route('**/api/agent/threads/*/documents', route => route.fulfill({ json: [doc] }));
  try {
    const panel = await openCoach(page);
    const input = panel.getByLabel('Message au coach');
    await input.fill('Ma semaine ?');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect.poll(() => stream.requests()).toBe(1);
    await input.fill('Garde mon dimanche libre.');
    for (const path of ['/settings', '/planning', '/log']) {
      await page.getByRole('navigation', { name: 'Navigation principale' }).locator(`a[href="${path}"]`).click();
      await expect(panel).toHaveCount(0);
      await page.getByRole('button', { name: 'Ouvrir le coach' }).click();
      await expect(input).toHaveValue('Garde mon dimanche libre.');
      await expect(panel.getByRole('button', { name: 'Arrêter la réponse' })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Fichiers du fil (1)' })).toBeVisible();
    }
    stream.send({ type: 'token', id: 'answer', text: 'Dimanche reste libre.' });
    stream.send({ type: 'done', message: { role: 'assistant', content: 'Dimanche reste libre.' } });
    await expect(panel.getByText('Dimanche reste libre.', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Retour à la page' }).click();
    await expect(page.getByRole('button', { name: 'Demander à Chiron', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Demander à Chiron', exact: true }).click();
    await expect(input).toHaveValue('Garde mon dimanche libre.');
    await page.reload();
    await expect(page).toHaveURL(/\/coach$/);
    await expect(panel).toHaveAttribute('data-display', 'embedded');
    await expect(input).toHaveValue('Garde mon dimanche libre.');
    await expect(page.locator('main')).toHaveCSS('margin-right', '0px');
    expect(stream.requests()).toBe(1);
  } finally { await stream.close(); }
});

for (const theme of ['pierre', 'prune']) {
  test(`embedded ${theme}: mobile bounds, shared focus and keyboard-accessible options`, async ({ page }) => {
    const stream = await fixture(page, false);
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      const panel = await openCoach(page);
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
      const box = (await panel.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(12);
      expect(box.x + box.width).toBeLessThanOrEqual(378);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
      expect(box.height).toBeLessThanOrEqual(844);
      const input = panel.getByLabel('Message au coach');
      await input.focus();
      await expect(input).toHaveCSS('outline-style', 'none');
      await expect(panel.locator('.coach-composer')).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
      const options = panel.getByRole('button', { name: 'Options du coach' });
      await options.focus();
      await options.press('Enter');
      await options.press('Tab');
      await expect(panel.getByRole('button', { name: 'Nouvelle conversation', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(options).toBeFocused();
      await expect(panel).toBeVisible();
      await expect(options).toHaveAttribute('aria-expanded', 'false');
      await page.screenshot({ path: `../.context/chiron-embedded-${theme}-mobile-app.png` });
    } finally { await stream.close(); }
  });
}

test('embedded mobile: long answers and menus stay inside a resized visual viewport', async ({ page }) => {
  const stream = await fixture(page);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const panel = await openCoach(page);
    await panel.getByLabel('Message au coach').fill('Détaille ma semaine.');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect.poll(() => stream.requests()).toBe(1);
    const text = 'Prévois une séance facile, puis récupère.\n\n'.repeat(30);
    stream.send({ type: 'token', id: 'answer', text });
    await expect(panel.locator('.coach-answer-part')).toContainText('Prévois une séance facile');
    stream.send({ type: 'done', message: { role: 'assistant', content: text } });
    await expect(panel.getByRole('button', { name: 'Envoyer', exact: true })).toBeVisible();
    expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(844);
    await panel.getByRole('button', { name: 'Options du coach' }).click();
    const menu = panel.getByRole('button', { name: 'Nouvelle conversation', exact: true }).locator('..');
    expect((await menu.boundingBox())!.y).toBeGreaterThanOrEqual(0);
    await panel.getByRole('button', { name: 'Ce que Chiron sait de moi' }).click();
    await expect(panel.getByText('Ce que je retiens de toi')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel.getByLabel('Message au coach')).toBeVisible();
    // Model the viewport resize event sent by mobile browsers when the keyboard opens.
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 400 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    const keyboardBox = (await panel.boundingBox())!;
    expect(keyboardBox.y).toBeGreaterThanOrEqual(0);
    expect(keyboardBox.y + keyboardBox.height).toBeLessThanOrEqual(400);
    await expect(panel.getByRole('button', { name: 'Envoyer', exact: true })).toBeVisible();
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: '../.context/chiron-embedded-keyboard-app.png' });
  } finally { await stream.close(); }
});

// ARE-164 with a mouse: the Garmin notice above the bar pushes the navigation down,
// including when it appears after opening; the page keeps the conversation below it.
for (const notice of ['shown', 'absent', 'appearing after opening'] as const) {
  test(`desktop: the embedded coach starts below the navigation (Garmin notice ${notice})`, async ({ page }) => {
    const stream = await fixture(page);
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      let state = notice === 'shown' ? 'partial' : 'fresh';
      await page.route('**/api/garmin/sync/ensure', route => route.fulfill({ json: { state } }));
      const ensured = page.waitForResponse('**/api/garmin/sync/ensure');
      const panel = await openCoach(page);
      await ensured;
      const status = page.getByRole('status').filter({ hasText: 'Garmin' });
      if (notice === 'appearing after opening') {
        await expect(status).toHaveCount(0);
        state = 'partial';
        // Coming back to the tab rechecks Garmin.
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      }
      if (notice === 'absent') await expect(status).toHaveCount(0);
      else await expect(status).toBeVisible();
      const nav = page.getByRole('navigation', { name: 'Navigation principale' });
      const navBottom = async () => { const bar = (await nav.boundingBox())!; return bar.y + bar.height; };
      const gap = async () => (await panel.locator('.coach-page-heading').boundingBox())!.y - await navBottom();
      expect(await navBottom()).toBeGreaterThan(notice === 'absent' ? 50 : 80);
      await expect.poll(gap).toBeGreaterThanOrEqual(-0.5);
      await expect.poll(gap).toBeLessThanOrEqual(48);
      const close = panel.getByRole('button', { name: 'Retour à la page' });
      const box = (await close.boundingBox())!;
      expect(await close.evaluate((button, [x, y]) => button.contains(document.elementFromPoint(x, y)), [box.x + box.width / 2, box.y + box.height / 2])).toBe(true);
      await close.click();
      await expect(panel).toBeHidden();
    } finally {
      await stream.close();
    }
  });
}
