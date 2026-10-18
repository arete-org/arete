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

test('ignoring a draft moves focus to the next one; free-text names are listed, not pre-filled', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-15T19:00:00'));
  let drafts = [draft(7, '2026-10-15'), draft(6, '2026-10-14')];
  const dismissed: string[] = [];
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1 } });
    if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'fresh' } });
    if (path === '/api/coach/today') return route.fulfill({ json: { items: [], remaining: 0, briefing: null } });
    if (path === '/api/strength/drafts') return route.fulfill({ json: { items: drafts, total: drafts.length } });
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
});
