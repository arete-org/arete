import { test, expect, type Route } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer, localDay } from './dashboardAnswer';

const session = {
  id: 7, date: localDay(), sport: 'running', session_type: 'easy', source: 'coach', description: 'Footing du jour', status: 'pending',
  revision: 1, target_duration_min: 40, target_distance_km: null, target_hr_zone: 2, target_intensity: null, garmin_workout_id: null, garmin_pushed_at: null,
};
const past = [{ id: 30, date: localDay(-1), tip: 'Hier : sortie longue tranquille.', source: 'agent', generated_at: null, reaction: 'down', reaction_comment: null }];

// The briefing leads the dashboard: a reaction is stored once on the server,
// the previous days are read on demand and a question opens the coach.
test('the briefing leads, takes a reaction, lists the previous days and opens the coach', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('arete.install.dismissed', '1');
    localStorage.setItem('arete.notifications.offered', '1');
  });
  const stored = { reaction: null as string | null, reaction_comment: null as string | null };
  const requests: string[] = [];
  const writes: unknown[] = [];
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    requests.push(`${request.method()} ${path}`);
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, display_name: 'HUNTER' } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, available: true } });
    if (path === '/api/dashboard') {
      const board = dashboardAnswer({ planned: [session] });
      return route.fulfill({ json: { ...board, briefing: { ...board.briefing, id: 41, ...stored } } });
    }
    if (path === '/api/tips/briefings/41/reaction') {
      const body = request.postDataJSON();
      writes.push(body);
      Object.assign(stored, { reaction: body.reaction, reaction_comment: body.comment });
      return route.fulfill({ json: { id: 41, ...stored } });
    }
    if (path === '/api/tips/history') return route.fulfill({ json: past });
    return route.fulfill({ json: [] });
  });

  await page.goto('/');
  const briefing = page.getByText('Prépare tes prochaines séances.');
  await expect(briefing).toBeVisible();
  // On a phone, right after the greeting and above today's session.
  const heading = (await page.getByRole('heading', { name: 'Bonjour, HUNTER' }).boundingBox())!;
  const lead = (await page.getByRole('heading', { name: 'BRIEFING DU JOUR' }).boundingBox())!;
  const today = (await page.getByRole('heading', { name: 'SÉANCE DU JOUR' }).boundingBox())!;
  expect(heading.y).toBeLessThan(lead.y);
  expect(lead.y).toBeLessThan(today.y);
  await expect(page.getByText('Footing du jour')).toBeVisible();

  await page.getByRole('button', { name: 'Utile', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Utile', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel(/Un mot sur ce briefing/).fill('Parfait avant le travail.');
  await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
  await expect(page.getByText('Ton mot : Parfait avant le travail.')).toBeVisible();
  expect(writes).toEqual([{ reaction: 'up', comment: null }, { reaction: 'up', comment: 'Parfait avant le travail.' }]);

  // The server keeps it: a reload shows the same answer.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Utile', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Ton mot : Parfait avant le travail.')).toBeVisible();

  expect(requests).not.toContain('GET /api/tips/history');
  await page.getByRole('button', { name: 'Briefings précédents' }).click();
  await expect(page.getByText('Hier : sortie longue tranquille.')).toBeVisible();
  expect(requests.filter(r => r === 'GET /api/tips/history')).toHaveLength(1);

  // The coach opens with the briefing selected; a draft stays and nothing is sent.
  await page.getByRole('button', { name: 'Demander à Chiron' }).click();
  const panel = page.getByRole('complementary', { name: 'Coach IA' });
  await panel.getByLabel('Message au coach').fill('Mon brouillon reste ici.');
  await panel.getByRole('button', { name: 'Masquer le coach' }).click();
  await page.getByRole('button', { name: 'Demander au coach' }).click();
  await expect(panel.getByText('Briefing sélectionné · prêt à en parler')).toBeVisible();
  await expect(panel.getByLabel('Message au coach')).toHaveValue('Mon brouillon reste ici.');
  expect(requests.filter(r => r.startsWith('POST /api/agent'))).toEqual([]);
});
