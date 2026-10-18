import { expect, test } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

const draft = (id: number, date: string) => ({
  id, actual_session_id: 40 + id, date, name: 'Musculation', duration_min: 45, origin: 'import',
  exercises: [
    { name: 'Squat arrière', exercise_id: 'back_squat', sets: 5, reps: 5 },
    { name: 'barbell shrug', exercise_id: null, sets: 3, reps: 12 },
  ],
  notation: 'Squat arrière 5x5',
});

test('ignoring a draft moves focus to the next one; free-text names are listed; matches read in French; « Tout ignorer » asks first', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-15T19:00:00'));
  let drafts = [draft(7, '2026-10-15'), draft(6, '2026-10-14')];
  const dismissed: string[] = [];
  const parsed = {
    success: true, date: '2026-10-14', name: null, duration_min: null, overall_rpe: null, notes: null,
    session_id: null, message: null, unparsed_lines: [], records: [],
    exercises: [{
      name: 'bench press', exercise_id: 'bench_press', exercise_matched: true, notes: null,
      suggestions: [{ exercise_id: 'bench_press', name: 'Bench Press', name_fr: 'Développé couché', score: 100 }],
      sets: [1, 2, 3].map((n) => ({ set_number: n, reps: 10, weight_kg: 80, is_warmup: false, is_failure: false })),
    }],
  };
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1 } });
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'fresh' } });
    if (path === '/api/coach/today') return route.fulfill({ json: { items: [], remaining: 0, briefing: null } });
    if (path === '/api/strength/drafts') return route.fulfill({ json: { items: drafts, total: drafts.length } });
    if (path === '/api/strength/sessions/parse') return route.fulfill({ json: parsed });
    if (path === '/api/strength/drafts/dismiss-all') {
      dismissed.push(path);
      drafts = [];
      return route.fulfill({ json: { dismissed: 1 } });
    }
    if (path.startsWith('/api/strength/drafts/') && request.method() === 'DELETE') {
      dismissed.push(path);
      drafts = drafts.filter((d) => `/api/strength/drafts/${d.id}` !== path);
      return route.fulfill({ json: { message: 'ok' } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto('/log');
  const list = page.getByRole('region', { name: 'À COMPLÉTER (2)' });
  await expect(list.getByRole('button', { name: 'Tout ignorer' })).toBeVisible();
  await list.getByRole('button', { name: /Ignorer la séance du jeu\. 15 oct\./ }).click();
  await expect(page.getByRole('region', { name: 'À COMPLÉTER (1)' })).toBeVisible();
  expect(dismissed).toEqual(['/api/strength/drafts/7']);
  await expect(page.getByRole('button', { name: 'Ajoute tes charges' })).toBeFocused();

  await page.getByRole('button', { name: 'Ajoute tes charges' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('textbox', { name: 'Séance en texte libre' })).toHaveValue('Squat arrière 5x5');
  await expect(dialog.getByText('Aussi vu par ta montre, à écrire avec tes mots : barbell shrug (3 séries)')).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Séance en texte libre' }).fill('bench press 3x10@80');
  await dialog.getByRole('button', { name: 'ANALYSER' }).click();
  await expect(dialog.getByText('✓ RECONNU : Développé couché')).toBeVisible();
  await dialog.getByRole('button', { name: 'Fermer', exact: true }).click();

  drafts = [draft(6, '2026-10-14'), draft(5, '2026-10-13')];
  await page.reload();
  const two = page.getByRole('region', { name: 'À COMPLÉTER (2)' });
  await two.getByRole('button', { name: 'Tout ignorer' }).click();
  await expect(two.getByText('Ignorer les 2 séances à compléter ? Tu pourras en rouvrir une depuis la séance.')).toBeVisible();
  expect(dismissed).toEqual(['/api/strength/drafts/7']);
  await two.getByRole('button', { name: 'Ignorer les 2' }).click();
  await expect(page.getByRole('region', { name: /À COMPLÉTER/ })).toBeHidden();
  expect(dismissed).toEqual(['/api/strength/drafts/7', '/api/strength/drafts/dismiss-all']);
});
