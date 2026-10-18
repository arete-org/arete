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
    const bubble = (await page.getByRole('button', { name: 'Demander à Chiron' }).boundingBox())!;
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
    await expect(page.getByRole('button', { name: 'Demander à Chiron' })).toBeHidden();
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
    await expect(dialog.getByRole('heading', { name: 'SÉANCE SANS MONTRE' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Fermer' }).tap();
    await nav.getByRole('link', { name: 'Tableau de bord' }).tap();
    // The RPG is off: the day's form reads in plain words, with no game tag nor level.
    const form = page.locator('.dashboard-secondary');
    await expect(page.getByRole('heading', { name: 'MA FORME DU JOUR' })).toBeVisible();
    await expect(form.getByText('Charge de la semaine')).toBeVisible();
    await expect(form.getByText(/^(HP|MP|XP|TSS)$/)).toHaveCount(0);
    await expect(form.getByText(/joueur|niveau/i)).toHaveCount(0);
    await noOverflow(page);
    await page.getByRole('link', { name: 'Saisir une séance', exact: true }).tap();
    await expect(dialog.getByRole('heading', { name: 'SAISIR UNE SÉANCE' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Fermer', exact: true }).tap();
    await nav.getByRole('link', { name: 'Profil', exact: true }).tap();
    await expect(page.getByRole('heading', { name: 'Mon profil' })).toBeInViewport();
    await expect(page.getByText('Active la gamification', { exact: false })).toBeVisible();
  });
}

test('floating default migrates once, survives navigation and fits the keyboard', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.goto('/log');
  await safeArea(page);
  const launcher = page.getByRole('button', { name: 'Demander à Chiron', exact: true });
  await launcher.tap();
  const panel = page.getByRole('complementary', { name: 'Coach IA' });
  await expect(panel).toHaveAttribute('data-display', 'floating');
  const input = panel.getByLabel('Message au coach');
  await input.fill('Ma séance : squats 3 × 8 à 60 kg');
  await page.getByRole('navigation', { name: 'Navigation mobile' }).getByRole('link', { name: 'Planning' }).tap();
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
  await panel.getByRole('button', { name: 'Options du coach' }).tap();
  await panel.getByRole('radio', { name: 'Panneau latéral classique' }).tap();
  await panel.getByRole('button', { name: 'Masquer le coach' }).tap();
  await expect(launcher).toBeInViewport();
  await page.reload();
  await launcher.tap();
  await expect(panel).toHaveAttribute('data-display', 'sidebar');
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
  await expect(dialog.getByRole('heading', { name: 'SÉANCE SANS MONTRE' })).toBeVisible();
  await page.route('**/api/garmin/actual', route => route.fulfill({ status: 503, json: { detail: 'Indisponible' } }));
  await dialog.getByPlaceholder('Footing au parc').fill('Séance à conserver');
  await dialog.getByRole('button', { name: 'ENREGISTRER', exact: true }).tap();
  await expect(dialog.getByText(/Enregistrement impossible/)).toBeVisible();
  await expect(dialog.getByPlaceholder('Footing au parc')).toHaveValue('Séance à conserver');
  await noOverflow(page);
});


test('touch navigation and display changes preserve a live response and manual draft', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const stream = await coachStream(page, false, 'floating');
  try {
    await page.goto('/planning');
    await expect(page.getByRole('heading', { name: 'Planning', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Demander à Chiron' }).tap();
    const panel = page.getByRole('complementary', { name: 'Coach IA' });
    const input = panel.getByLabel('Message au coach');
    await input.fill('Comment adapter ma semaine ?');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).tap();
    await expect.poll(() => stream.requests()).toBe(1);
    stream.send({ type: 'token', id: 'answer', text: 'Préserve une journée de récupération.' });
    await expect(panel.locator('.coach-answer-part')).toContainText('Préserve une journée');
    await input.fill('Garde mon dimanche libre.');
    await page.getByRole('navigation', { name: 'Navigation mobile' }).getByRole('link', { name: 'Journal' }).tap();
    await expect(page.getByRole('heading', { name: 'Journal', exact: true })).toBeVisible();
    await expect(input).toHaveValue('Garde mon dimanche libre.');
    await panel.getByRole('button', { name: 'Options du coach' }).tap();
    await panel.getByRole('radio', { name: 'Panneau latéral classique' }).tap();
    await expect(panel).toHaveAttribute('data-display', 'sidebar');
    await expect(input).toHaveValue('Garde mon dimanche libre.');
    stream.send({ type: 'token', id: 'answer', text: ' Dimanche reste libre.' });
    stream.send({ type: 'done', message: { role: 'assistant', content: 'Préserve une journée de récupération. Dimanche reste libre.' } });
    await expect(panel.getByRole('button', { name: 'Envoyer', exact: true })).toBeVisible();
    expect(stream.requests()).toBe(1);
    await panel.getByRole('button', { name: 'Options du coach' }).tap();
    await panel.getByRole('radio', { name: 'Chat flottant' }).tap();
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
  await page.getByRole('button', { name: 'Demander à Chiron' }).tap();
  const panel = page.getByRole('complementary', { name: 'Coach IA' });
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
    if (path === '/api/strength/drafts') return route.fulfill({ json: completed ? [] : [draft] });
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
  const drafts = page.getByRole('region', { name: 'À COMPLÉTER (1)' });
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
  await dialog.getByRole('button', { name: 'ANALYSER' }).tap(); // 3
  await dialog.getByRole('button', { name: 'ENREGISTRER' }).tap(); // 4

  await expect(dialog.getByText('SÉANCE ENREGISTRÉE')).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'Nouveaux records' })).toBeVisible();
  expect(completions).toEqual([{ text: 'Développé couché 3x10@80\nSquat 5x5@100' }]);
  await page.screenshot({ path: '../.context/are-132/completed-mobile.png', animations: 'disabled' });
  // The completed draft leaves the list; its screen stays until closed.
  await expect(drafts).toBeHidden();
  await dialog.getByRole('button', { name: 'FERMER', exact: true }).tap();
  await expect(page).toHaveURL(/\/log$/);
});
