import { test, expect, type Page } from '@playwright/test';

const WEEK = ['2027-01-11', '2027-01-12', '2027-01-13', '2027-01-14', '2027-01-15'];
const sessions = Array.from({ length: 10 }, (_, i) => ({
  id: 100 + i, revision: 1, date: WEEK[i % 5], sport: 'running', session_type: 'easy', source: 'coach',
  description: `Footing ${i + 1}`, status: 'pending', summary: '40 min Z2', exportable: true, derived: true, prescription: null,
  target_duration_min: 40, target_distance_km: null, target_hr_zone: 2, target_intensity: null, garmin_workout_id: null, garmin_pushed_at: null,
}));
const scheduled = (id: number) => ({ session_id: id, operation_id: `op-${id}`, updated_at: '2027-01-10T08:00:00Z', state: 'scheduled', phase: 'scheduled', error: null, deleted: false, workout_id: id, schedule_id: id });
const view = (id: number) => ({ session: sessions.find(s => s.id === id), export: scheduled(id) });

/** Every API request the page sends; the dev server's StrictMode doubles the auth config read. */
async function record(page: Page) {
  const requests: string[] = [];
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (!path.endsWith('/auth/config')) requests.push(`${path}${url.search}`);
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path.endsWith('/garmin/sync/ensure')) return route.fulfill({ json: { state: 'fresh', complete: true } });
    if (path.endsWith('/auth/config')) return route.fulfill({ json: { enabled: false } });
    if (path.endsWith('/settings/gamification')) return route.fulfill({ json: { enabled: false, opted_in: false, available: true, version: 1 } });
    if (path.endsWith('/garmin/planned')) return route.fulfill({ json: sessions });
    if (path.endsWith('/garmin/exports')) return route.fulfill({ json: sessions.slice(0, 5).map(s => scheduled(s.id)) });
    const one = path.match(/\/garmin\/planned\/(\d+)\/workout$/);
    if (one) return route.fulfill({ json: view(Number(one[1])) });
    if (path.endsWith('/garmin/workouts')) return route.fulfill({ json: { workouts: url.searchParams.getAll('ids').map(id => view(Number(id))), errors: {} } });
    if (path.includes('/settings')) return route.fulfill({ json: {} });
    return route.fulfill({ json: [] });
  });
  return requests;
}
const workoutReads = (requests: string[]) => requests.filter(r => r.includes('/workout'));

test('a Planning week with 10 sessions loads with a constant number of requests', async ({ page }) => {
  const requests = await record(page);
  await page.goto('/planning?date=2027-01-12');
  await expect(page.getByTestId('workout-109')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(workoutReads(requests)).toEqual([]);
  // Settings, game preference, shared inbox, planned, actual, strength, Garmin states, one freshness check.
  expect(requests.filter(r => r === '/api/garmin/sync/ensure')).toHaveLength(1);
  expect(requests.length, requests.join('\n')).toBeLessThanOrEqual(8);
  // The collapsed review and goal projection load when opened.
  await page.getByText('Bilan et objectifs', { exact: true }).click();
  await expect.poll(() => requests.some(r => r.endsWith('/plan/review'))).toBe(true);
});

test('the coach reads its workout cards once and not again when reopened', async ({ page }) => {
  const requests = await record(page);
  await page.addInitScript(views => {
    localStorage.setItem('arete.coach.threads.v1', JSON.stringify({ version: 1, activeId: 't1', threads: [{
      id: 't1', title: 'Semaine', createdAt: Date.now(), updatedAt: Date.now(), draft: '',
      messages: [{ role: 'user', content: 'Envoie ma semaine' }, { role: 'assistant', content: 'C’est fait.', workouts: views }],
    }] }));
  }, sessions.slice(0, 5).map(s => ({ type: 'workout_update', id: `w-${s.id}`, thread_id: 't1', sequence: 1, ...view(s.id) })));
  await page.goto('/planning?date=2027-01-12');
  await expect(page.getByTestId('workout-109')).toBeVisible();
  const open = () => page.getByRole('button', { name: /^(Ouvrir le coach|Demander (?:au coach|à Chiron))$/ }).filter({ visible: true }).first().click();
  await open();
  const panel = page.getByRole('complementary', { name: 'Coach IA' });
  await expect(panel.getByTestId('workout-104').getByText('Programmée dans Garmin Connect', { exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(workoutReads(requests)).toEqual(['/api/garmin/workouts?ids=100&ids=101&ids=102&ids=103&ids=104']);
  await panel.getByRole('button', { name: 'Masquer le coach' }).click();
  const before = requests.length;
  await open();
  await expect(panel.getByTestId('workout-104').getByText('Programmée dans Garmin Connect', { exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(requests.slice(before)).toEqual([]);
});
