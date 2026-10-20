import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The browser talks to the actual HTTP handlers and a disposable DuckDB database.
// Only unrelated page reads and external integrations are stubbed.
const API_REQUEST_TIMEOUT_MS = 10_000;
const API = 'http://127.0.0.1:18761';
let server: ChildProcess;
let directory: string;
let output = '';
test.beforeAll(async ({ request }) => {
  directory = await mkdtemp(resolve('../.context/planning-e2e-'));
  server = spawn(
    resolve('../.venv/bin/python'),
    [
      '-m',
      'uvicorn',
      'arete.api.main:app',
      '--app-dir',
      'src',
      '--host',
      '127.0.0.1',
      '--port',
      '18761',
    ],
    {
      cwd: resolve('..'),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PYTHON_DOTENV_DISABLED: '1',
        ARETE_DB: `${directory}/planning.duckdb`,
        LANGSMITH_TRACING: 'false',
        ARETE_AUTH: '',
      },
    },
  );
  server.stdout?.on('data', (chunk) => {
    output += chunk;
  });
  server.stderr?.on('data', (chunk) => {
    output += chunk;
  });
  await expect
    .poll(
      async () => {
        if (server.exitCode !== null) throw new Error(output);
        try {
          return (await request.get(`${API}/health`, { timeout: 1000 })).status();
        } catch {
          return 0;
        }
      },
      { timeout: 20_000 },
    )
    .toBe(200);
});
test.afterEach(async ({ page }) => {
  // React Query can still be fetching when the final assertion finishes. Drain
  // routed API calls before Playwright disposes their request context.
  await page.unrouteAll({ behavior: 'wait' });
});
test.afterAll(async () => {
  if (server?.exitCode === null) {
    const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }
  await writeFile('../.context/planning-e2e-api.log', output);
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function connect(page: Page) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '');
    if (path === '/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (
      /^\/garmin\/(planned|actual|exports)/.test(path) ||
      path === '/strength/sessions' ||
      path.startsWith('/coach/plan-changes') ||
      path === '/coach/attention' ||
      path === '/settings'
    ) {
      return route.fulfill({
        response: await route.fetch({
          timeout: API_REQUEST_TIMEOUT_MS,
          maxRetries: 0,
          url: `${API}${path}${new URL(route.request().url()).search}`,
        }),
      });
    }
    if (path.includes('/agent/')) throw new Error(`Unexpected model request: ${path}`);
    if (path === '/auth/config') return route.fulfill({ json: { enabled: false } });
    return route.fulfill({ json: [] });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
}
async function openDetail(page: Page, title: string, mobile: boolean) {
  const card = page.locator('.planning-session').filter({ hasText: title });
  if (mobile)
    await card.getByRole('button', { name: `Ouvrir la séance ${title}`, exact: true }).click();
  else {
    await card.getByRole('button', { name: title, exact: true }).click();
    await page.getByRole('button', { name: 'Ouvrir la séance' }).click();
  }
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Modifier', exact: true }),
  ).toBeEnabled();
}

for (const width of [1440, 390]) {
  test(`proposal A full CRUD persists through HTTP and reload at ${width}px`, async ({
    page,
    request,
  }) => {
    const existing = await (await request.get(`${API}/garmin/planned`)).json();
    for (const session of existing)
      expect(
        (
          await request.delete(`${API}/garmin/planned/${session.id}?revision=${session.revision}`)
        ).ok(),
      ).toBe(true);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await connect(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/planning?date=2027-01-12&new=1');
    await page.getByRole('button', { name: 'Depuis un modèle' }).click();
    await page.getByRole('button', { name: 'Fractionné · 20 × 300 m', exact: true }).click();
    await page.getByLabel('Titre', { exact: true }).fill('Fractionné du mardi');
    await page.getByRole('button', { name: 'Créer la séance', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    let sessions = await (await request.get(`${API}/garmin/planned`)).json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].prescription.steps[1].repeat).toBe(20);
    await page.reload();
    await openDetail(page, 'Fractionné du mardi', width < 1000);
    await page.getByRole('button', { name: 'Modifier', exact: true }).click();
    await page.getByLabel('Titre', { exact: true }).fill('Fractionné ajusté');
    await page.locator('summary').filter({ hasText: '2. Répéter un bloc' }).click();
    await page.getByLabel('Nombre de répétitions', { exact: true }).fill('12');
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await openDetail(page, 'Fractionné ajusté', width < 1000);
    await expect(
      page.getByRole('dialog').getByText('12 répétitions', { exact: false }).first(),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Déplacer', exact: true }).click();
    await page.getByLabel('Nouvelle date').fill('2027-01-14');
    await page.getByRole('dialog').getByRole('button', { name: 'Déplacer', exact: true }).click();
    await expect(page).toHaveURL(/date=2027-01-14/);
    await openDetail(page, 'Fractionné ajusté', width < 1000);
    await page.getByRole('button', { name: 'Dupliquer', exact: true }).click();
    await page.getByLabel('Titre', { exact: true }).fill('Copie du fractionné');
    await page.getByLabel('Date', { exact: true }).fill('2027-01-15');
    await page.getByRole('button', { name: 'Créer la copie', exact: true }).click();
    await expect(page).toHaveURL(/date=2027-01-15/);
    await openDetail(page, 'Copie du fractionné', width < 1000);
    await page.getByRole('button', { name: 'Marquer réalisée', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    sessions = await (await request.get(`${API}/garmin/planned`)).json();
    expect(
      sessions.find((s: { description: string }) => s.description === 'Copie du fractionné').status,
    ).toBe('completed');
    await openDetail(page, 'Copie du fractionné', width < 1000);
    await page.getByRole('button', { name: 'Supprimer la séance', exact: true }).click();
    await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await (await request.get(`${API}/garmin/planned`)).json()).toHaveLength(1);
    await page.goto('/planning?date=2027-01-14');
    await openDetail(page, 'Fractionné ajusté', width < 1000);
    await page.getByRole('button', { name: 'Modifier', exact: true }).click();
    await page.getByLabel('Titre', { exact: true }).fill('Brouillon conservé');
    const current = (await (await request.get(`${API}/garmin/planned`)).json())[0];
    expect(
      (
        await request.patch(`${API}/garmin/planned/${current.id}`, {
          data: { revision: current.revision, status: 'skipped' },
        })
      ).ok(),
    ).toBe(true);
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'La séance a changé' })).toBeVisible();
    await expect(page.getByLabel('Titre', { exact: true })).toHaveValue('Brouillon conservé');
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    await page.getByRole('button', { name: 'Abandonner', exact: true }).click();
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.evaluate(() => (document.documentElement.dataset.theme = 'pierre'));
    const options = page.getByRole('button', { name: 'Options du planning' });
    await options.click();
    const menu = page.getByRole('dialog', { name: 'Options du planning' });
    await expect(menu.getByLabel('Filtrer par sport')).toBeFocused();
    const menuBounds = (await menu.boundingBox())!;
    const triggerBounds = (await options.boundingBox())!;
    expect(menuBounds.y).toBeGreaterThanOrEqual(triggerBounds.y + triggerBounds.height);
    await page.screenshot({ path: `../.context/arete-week-options-${width}.png`, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(options).toBeFocused();
    await options.click();
    await page.getByRole('heading', { name: 'Planning', exact: true }).click();
    await expect(menu).toHaveCount(0);
    await page.evaluate(() => (document.documentElement.dataset.theme = 'odyssey'));
    await page.screenshot({
      path: `../.context/planning-a-${width}.png`,
      fullPage: false,
    });
  });
}

test('mobile prioritizes sessions, uses one focus ring and stays usable in every theme', async ({
  page,
  request,
}) => {
  const existing = await (await request.get(`${API}/garmin/planned`)).json();
  for (const session of existing)
    await request.delete(`${API}/garmin/planned/${session.id}?revision=${session.revision}`);
  const seeds = [
    {
      date: '2027-01-11',
      description: 'Endurance',
      sport: 'running',
      target_duration_min: 45,
    },
    {
      date: '2027-01-12',
      description: 'Fractionné',
      sport: 'running',
      prescription: {
        version: 1,
        steps: [
          { kind: 'warmup', duration_kind: 'lap' },
          {
            kind: 'repeat',
            repeat: 20,
            duration_kind: 'lap',
            steps: [
              { kind: 'effort', duration_kind: 'meters', value: 300 },
              { kind: 'recovery', duration_kind: 'meters', value: 100 },
            ],
          },
          { kind: 'cooldown', duration_kind: 'lap' },
        ],
      },
    },
    {
      date: '2027-01-14',
      description: 'Force complète',
      sport: 'strength',
      target_duration_min: 45,
    },
    {
      date: '2027-01-15',
      description: 'Footing facile',
      sport: 'running',
      target_duration_min: 45,
    },
    {
      date: '2027-01-17',
      description: 'Sortie longue',
      sport: 'running',
      target_duration_min: 80,
    },
  ];
  for (const session of seeds)
    expect(
      (
        await request.post(`${API}/garmin/planned`, {
          data: { ...session, session_type: 'endurance', source: 'manual' },
        })
      ).ok(),
    ).toBe(true);
  await connect(page);
  await page.goto('/planning?date=2027-01-12');
  for (const width of [360, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of [
      'pierre',
      'prune',
      'odyssey',
      'encre',
    ]) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const open = page.getByRole('button', {
        name: 'Ouvrir la séance Fractionné',
        exact: true,
      });
      await expect(open).toBeVisible();
      const bounds = await open.boundingBox();
      expect(bounds!.y).toBeLessThan(520);
      const cardBounds = await page
        .locator('.planning-session')
        .filter({ has: open })
        .boundingBox();
      expect(cardBounds!.height).toBeGreaterThanOrEqual(44);
      await expect(
        page.getByRole('button', { name: 'Ouvrir la séance', exact: true }),
      ).toBeVisible();
      await expect(page.locator('h1')).toHaveCSS('font-family', /Cormorant Garamond/);
      await expect(page.locator('h1')).toHaveCSS('font-weight', '600');
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Options du planning' }).click();
  await page.getByRole('dialog').getByLabel('Filtrer par sport').selectOption('cycling');
  await page.keyboard.press('Escape');
  await expect(page.getByText('Aucune séance pour ce sport', { exact: true }).filter({ visible: true })).toBeVisible();
  await page.getByRole('button', { name: 'Options du planning' }).click();
  await page.getByRole('dialog').getByLabel('Filtrer par sport').selectOption('');
  await page.keyboard.press('Escape');
  // Planning keeps the shared page title and the navigation of every other page.
  await expect(page.locator('h1')).toHaveCSS('font-size', '36px');
  await expect(
    page.getByRole('navigation', { name: 'Navigation mobile' }).getByRole('link'),
  ).toHaveText(['Accueil', 'Planning', 'Analyses', 'Journal', 'Profil', 'Réglages']);
  await expect(page.getByRole('button', { name: 'Options du planning' })).toBeInViewport();
  expect(
    await page.evaluate(async () =>
      (await document.fonts.load('600 16px Inter')).map((font) => font.weight),
    ),
  ).toContain('600');
  await page.getByRole('button', { name: 'Ouvrir la séance Fractionné', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Modifier', exact: true }).click();
  await expect(page.getByLabel('Titre', { exact: true })).toHaveCSS('font-size', '16px');
  await page.screenshot({
    path: '../.context/planning-a-editor-390.png',
    fullPage: false,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.planning-session-active')).toHaveCSS('box-shadow', 'none');
  await expect(page.locator('.planning-card-open').filter({ visible: true })).toHaveCSS(
    'outline-style',
    'none',
  );
  await expect(page.locator('.planning-session-active')).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: '../.context/planning-a-keyboard-390.png',
    fullPage: false,
    animations: 'disabled',
  });
  await page.getByRole('heading', { name: 'Planning', exact: true }).click();
  await writeFile(
    '../.context/planning-select-style.json',
    JSON.stringify(
      await page.locator('.planning-toolbar select').evaluate((el) => ({
        color: getComputedStyle(el).color,
        background: getComputedStyle(el).backgroundColor,
        token: getComputedStyle(el).getPropertyValue('--color-abyss'),
      })),
    ),
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: '../.context/planning-a-390.png',
    fullPage: false,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator('h1')).toHaveCSS('font-size', '44px');
  // The weekday and the date read as a pair rather than at opposite ends of the column.
  const heading = page.locator('.planning-day-heading').first();
  const weekday = (await heading.locator('h3').boundingBox())!;
  const date = (await heading.locator('span').boundingBox())!;
  expect(date.x - (weekday.x + weekday.width)).toBeLessThan(16);
  await page.screenshot({
    path: '../.context/planning-a-1440.png',
    fullPage: false,
    animations: 'disabled',
  });
});

for (const width of [1440, 390]) {
  test(`grouped adjustment shows before/after and commits through HTTP at ${width}px`, async ({ page, request }) => {
    const day = new Date();
    day.setDate(day.getDate() + 4);
    const date = day.toLocaleDateString('sv-SE');
    const create = async (description: string) => {
      const response = await request.post(`${API}/garmin/planned`, { data: { date, sport: 'running', session_type: 'endurance', description, target_duration_min: 40 } });
      expect(response.ok()).toBe(true);
      return response.json();
    };
    const first = await create(`Sortie groupée A ${width}`);
    const second = await create(`Sortie groupée B ${width}`);
    const draft = await request.post(`${API}/coach/plan-changes`, { data: { items: [first, second].map(session => ({ session_id: session.id, revision: session.revision, changes: { target_duration_min: 30 } })) } });
    expect(draft.ok(), await draft.text()).toBe(true);
    const preview = await draft.json();
    await connect(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/planning?date=${date}&change_set=${preview.id}`);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Ajuster 2 séances' })).toBeVisible();
    await expect(dialog.getByText('Avant', { exact: true })).toHaveCount(2);
    await expect(dialog.getByText('Après', { exact: true })).toHaveCount(2);
    await page.screenshot({ path: `../.context/arete-plan-change-${width}.png`, animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Appliquer les changements' }).click();
    await expect(dialog.getByRole('status')).toContainText('Le planning Arete est enregistré');
    await page.reload();
    await expect(page.getByRole('dialog').getByRole('status')).toContainText('Le planning Arete est enregistré');
    const saved = (await (await request.get(`${API}/garmin/planned`)).json()).filter((session: { id: number }) => [first.id, second.id].includes(session.id));
    expect(saved).toHaveLength(2);
    expect(saved.every((session: { target_duration_min: number; revision: number }) => session.target_duration_min === 30 && session.revision === 2)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
