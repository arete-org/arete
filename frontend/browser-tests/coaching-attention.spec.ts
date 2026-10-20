import { expect, test } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';
import { dashboardAnswer } from './dashboardAnswer';

for (const width of [1440, 390]) {
  test(`active priority opens one RPE owner without sending the draft at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const answers: unknown[] = [];
    const chats: string[] = [];
    let answered = false;
    let unavailable = false;
    const followup = () => ({
      id: 42, session_id: 12, decision_id: null, revision: answered ? 2 : 1,
      state: answered ? 'answered' : 'pending', question: 'Quel ressenti après ta sortie ?',
      rpe: answered ? 7 : null, notes: answered ? 'Jambes légères.' : null,
      expires_at: '2099-10-20T21:59:59Z', requested_on: '2026-10-18',
    });
    await page.route('**/api/**', route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
      if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, theme: 'pierre' } });
      if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, available: true } });
      if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'disconnected' } });
      if (path === '/api/dashboard') return route.fulfill({ json: dashboardAnswer() });
      if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
      if (path === '/api/coach/attention') return unavailable
        ? route.fulfill({ status: 503, json: { detail: 'Indisponible' } })
        : route.fulfill({ json: { enabled: true, remaining: 0, primary_ref: answered ? null : 'followup:42', items: answered ? [] : [{
          source_ref: 'followup:42', subject_key: 'session:12:perceived_effort', kind: 'question',
          title: 'Quel ressenti après ta sortie ?', url: '/follow-up?followup=42', expires_at: '2099-10-20T21:59:59Z',
        }] } });
      if (path === '/api/coach/today') return route.fulfill({ json: { items: answered ? [] : [{ kind: 'followup', record: followup() }], remaining: 0, briefing: null } });
      if (path === '/api/coach/followups/42') return route.fulfill({ json: followup() });
      if (path === '/api/coach/followups/42/response') {
        answers.push(request.postDataJSON()); answered = true;
        return route.fulfill({ json: followup() });
      }
      if (path.includes('/agent/chat')) chats.push(path);
      return route.fulfill({ json: [] });
    });
    await page.goto('/');
    await page.getByRole('button', { name: /^(Ouvrir le coach|Demander à (?:Coach|Chiron))$/ }).filter({ visible: true }).first().click();
    const panel = page.getByRole('complementary', { name: 'Coach IA' });
    await panel.getByLabel('Message au coach').fill('Mon brouillon attend.');
    await panel.getByRole('button', { name: 'Masquer le coach' }).click();
    await page.getByRole('link', { name: /Quel ressenti après ta sortie/ }).click();
    await expect(page).toHaveURL(/followup=42/);
    await expect(panel.getByText('Quel ressenti après ta sortie ?', { exact: true })).toBeVisible();
    await panel.getByLabel('Effort ressenti', { exact: true }).selectOption('7');
    await panel.getByLabel('Note de séance').fill('Jambes légères.');
    await panel.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await expect(panel.getByText('Ressenti enregistré : 7/10 — Jambes légères.')).toBeVisible();
    expect(answers).toEqual([{ revision: 1, action: 'answer', rpe: 7, notes: 'Jambes légères.' }]);
    expect(chats).toEqual([]);
    await expect(panel.getByLabel('Message au coach')).toHaveValue('Mon brouillon attend.');
    await page.screenshot({ path: `../.context/arete-attention-${width}.png` });
    await page.reload();
    await expect(page.getByText('Ressenti enregistré : 7/10 — Jambes légères.')).toBeVisible();
    expect(answers).toHaveLength(1);
    expect(chats).toEqual([]);
    unavailable = true;
    await page.goto('/');
    await expect(page.getByRole('alert').filter({ hasText: 'Priorités de Coach indisponibles.' })).toBeVisible();
  });
}
