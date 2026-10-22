import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

/** What the server answers for each file name (one request per file). */
const ANSWERS: Record<string, object> = {
  'matin.fit': { status: 'imported', message: 'Séance importée et associée à ta séance prévue.', session_id: 41, date: '2026-10-14', sport: 'running' },
  'velo.tcx': { status: 'duplicate', message: 'Doublon : cette séance est déjà dans Arete (Garmin, le 13/10/2026 à 18:05).', duplicate_of: 7 },
  'rando.gpx': { status: 'error', message: 'Pas d’heure de départ : ce fichier décrit un itinéraire, pas une séance enregistrée.' },
};

async function mockApi(page: Page, sent: string[]) {
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1 } });
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'fresh' } });
    if (path === '/api/coach/today') return route.fulfill({ json: { items: [], remaining: 0, briefing: null } });
    if (path === '/api/strength/drafts') return route.fulfill({ json: { items: [], total: 0 } });
    // One file imported: the coach's word on it, as after a single upload.
    if (path === '/api/tips/post-session') {
      sent.push(`feedback:${request.postDataJSON().session_id}`);
      return route.fulfill({ json: { feedback: 'Footing régulier, cardio bien tenu.', highlights: [], source: 'rules' } });
    }
    if (path === '/api/activities/import') {
      const filename = /filename="([^"]+)"/.exec(request.postDataBuffer()?.toString('latin1') ?? '')?.[1] ?? '';
      sent.push(filename);
      return route.fulfill({ json: { results: [{ filename, ...ANSWERS[filename] }] } });
    }
    return route.fulfill({ json: [] });
  });
}

const FILES = [
  { name: 'matin.fit', mimeType: 'application/octet-stream', buffer: Buffer.from('fit') },
  { name: 'velo.tcx', mimeType: 'application/xml', buffer: Buffer.from('<TrainingCenterDatabase/>') },
  { name: 'rando.gpx', mimeType: 'application/xml', buffer: Buffer.from('<gpx/>') },
];

async function expectThreeOutcomes(page: Page) {
  const results = page.getByRole('list', { name: 'Résultats de l’import' });
  await expect(results.getByRole('listitem')).toHaveCount(3);
  const [fit, tcx, gpx] = [0, 1, 2].map((i) => results.getByRole('listitem').nth(i));
  await expect(fit).toContainText('matin.fit');
  await expect(fit).toContainText('Importé');
  await expect(fit.getByRole('link', { name: 'Voir la séance' })).toHaveAttribute('href', '/log/sessions/41');
  await expect(tcx).toContainText('Déjà dans Arete');
  await expect(tcx).toContainText('Doublon : cette séance est déjà dans Arete (Garmin, le 13/10/2026 à 18:05).');
  await expect(tcx.getByRole('link', { name: 'Voir la séance existante' })).toHaveAttribute('href', '/log/sessions/7');
  await expect(gpx).toContainText('Refusé');
  await expect(gpx).toContainText('Pas d’heure de départ');
  await expect(page.getByText('Dépose tes fichiers d’activité ici')).toBeVisible(); // ready again
  await expect(page.getByText('Footing régulier, cardio bien tenu.')).toBeVisible();
}

test('desktop: picking three files imports them one by one with an outcome each', async ({ page }) => {
  const sent: string[] = [];
  await mockApi(page, sent);
  await page.goto('/log?tab=cardio');
  await expect(page.getByText('Dépose tes fichiers d’activité ici')).toBeVisible();
  await page.getByLabel('Importer une activité').setInputFiles(FILES);
  await expectThreeOutcomes(page);
  expect(sent).toEqual(['matin.fit', 'velo.tcx', 'rando.gpx', 'feedback:41']);
});

test.describe('390 px', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('dropping three files shows three outcomes without horizontal scroll', async ({ page }) => {
    const sent: string[] = [];
    await mockApi(page, sent);
    await page.goto('/log?tab=cardio');
    const zone = page.getByText('Dépose tes fichiers d’activité ici');
    await expect(zone).toBeVisible();
    const transfer = await page.evaluateHandle((files) => {
      const data = new DataTransfer();
      for (const f of files) data.items.add(new File([f.text], f.name));
      return data;
    }, FILES.map((f) => ({ name: f.name, text: f.buffer.toString() })));
    await page.getByLabel('Importer une activité').dispatchEvent('drop', { dataTransfer: transfer });
    await expectThreeOutcomes(page);
    expect(sent).toEqual(['matin.fit', 'velo.tcx', 'rando.gpx', 'feedback:41']);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: '../.context/activity-import-mobile.png', animations: 'disabled', fullPage: true });
  });
});

test('Connexions points other watches to the import', async ({ page }) => {
  await mockApi(page, []);
  await page.route('**/api/garmin/sync/status', (route) => route.fulfill({ json: { garmin_authenticated: false } }));
  await page.goto('/settings?tab=connections');
  await expect(page.getByText('Autres montres')).toBeVisible();
  await page.getByRole('link', { name: 'Importer une activité →' }).click();
  await expect(page).toHaveURL(/\/log\?tab=cardio$/);
  await expect(page.getByText('Dépose tes fichiers d’activité ici')).toBeVisible();
});
