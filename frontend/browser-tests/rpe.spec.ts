import { expect, test } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

const detail = {
  session: {
    id: 12, date: '2026-10-08', start_time: '2026-10-08T07:30:00', sport: 'running', session_type: 'running',
    name: 'Footing du matin', duration_sec: 3000, moving_time_sec: 2940, distance_m: 10200, calories: 640,
    avg_hr: 142, max_hr: 160, avg_pace_sec_km: 290, avg_speed_mps: 3.45, max_speed_mps: 4.1, ascent_m: 40,
    descent_m: 38, avg_cadence: 176, max_cadence: 190, avg_watts: null, rpe: null, notes: null,
    source: 'garmin_connect', device_name: null, planned_session_id: null, adherence_score: null,
  },
  zones: null, laps: [], splits: [], intervals: null, metrics: null, streams: null, route: null,
  feedback: { text: 'Footing bien dosé, le cardio est resté bas.', source: 'agent', trigger: 'sync', created_at: null },
  terrain: null, weather: null,
  summary: { rule_feedback: null, strength: null, plan: null, next_day: null },
};

test('the post-session link opens the RPE picker, one tap saves it', async ({ page }) => {
  const patches: unknown[] = [];
  let rpe: number | null = null;
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1 } });
    if (path === '/api/analytics/sessions/12/detail') return route.fulfill({ json: { ...detail, session: { ...detail.session, rpe } } });
    if (path === '/api/analytics/sessions/12' && route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      patches.push(body);
      rpe = body.rpe;
      return route.fulfill({ json: { success: true } });
    }
    return route.fulfill({ json: [] });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/log/sessions/12?rpe=1');
  const picker = page.getByRole('region', { name: 'Effort ressenti' });
  await expect(picker).toBeVisible();
  await expect(page.getByRole('button', { name: '1 — très facile' })).toBeFocused();
  await page.screenshot({ path: '../.context/rpe-picker-mobile.png', animations: 'disabled' });
  await page.getByRole('button', { name: '6 — dur +' }).click();
  await expect(picker).toBeHidden();
  expect(patches).toEqual([{ rpe: 6 }]);
  await expect(page.getByText('RPE 6')).toBeVisible();
});
