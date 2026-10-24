import { expect, test } from '@playwright/test';
import { coachStream } from './coachStream';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

for (const theme of ['pierre', 'prune', 'odyssey', 'encre']) for (const width of [390, 1440]) {
  test(`Typed chat resumes after reload · ${theme} · ${width}`, async ({ page }) => {
    const stream = await coachStream(page, true);
    const id = '11111111-1111-4111-8111-111111111111';
    let state = 'waiting', attempts = 0, resumes = 0;
    const item = {
      id: 'question', revision: 1, expires_at: '2099-01-01T00:00:00Z', decision: null as unknown,
      payload: { type: 'question', name: 'ask_athlete', args: { question: 'Combien de minutes as-tu demain ?' } },
      schema: { type: 'object', properties: { minutes: { type: 'integer', title: 'Minutes disponibles', minimum: 10, maximum: 120 } }, required: ['minutes'], additionalProperties: false },
    };
    const events = [
      { type: 'run_status', state: 'running' },
      { type: 'activity', id: 'context', state: 'done', label: 'Contexte préparé' },
      { type: 'message', id: 'answer', text: 'Une précision pour adapter ta séance.' },
      { type: 'interrupt', interrupt: item },
      { type: 'run_status', state: 'waiting' },
    ].map((event, i) => ({ ...event, stream_version: 2, run_id: id, seq: i + 1 }));
    const saved = () => ({ id, state, interrupts: [item], activity: { id, state, revision: 1, projection: { seq: 5, events } } });
    await page.route('**/api/settings', route => route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, theme } }));
    await page.route('**/api/agent/runs/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/interrupts/question')) {
        attempts++;
        if (attempts === 1) return route.fulfill({ status: 422, json: { detail: 'Réponse non enregistrée. Corrige puis réessaie.' } });
        item.decision = route.request().postDataJSON().decision;
        state = 'ready';
        return route.fulfill({ json: saved() });
      }
      if (path.endsWith('/resume')) {
        resumes++; state = 'completed';
        return route.fulfill({ contentType: 'text/event-stream', body: [
          { type: 'run_status', state: 'running' },
          { type: 'message', id: 'answer', text: 'Ta séance de 30 minutes est prête.' },
          { type: 'done', message: { role: 'assistant', content: 'Ta séance de 30 minutes est prête.' } },
        ].map((event,i) => `data: ${JSON.stringify({ ...event, stream_version: 2, run_id: id, seq: i + 6 })}\n\n`).join('') });
      }
      return route.fulfill({ json: saved() });
    });
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/planning');
      const open = page.getByRole('button', { name: /^(Ouvrir le coach|Demander (?:au coach|à Chiron))$/ }).filter({ visible: true }).first();
      await open.click();
      const panel = page.getByRole('region', { name: 'Coach IA' });
      await panel.getByLabel('Message au coach').fill('Adapte ma séance de demain.');
      await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
      await expect.poll(() => stream.requests()).toBe(1);
      for (const event of events) stream.send(event);
      await expect(panel.getByLabel('Minutes disponibles')).toBeVisible();
      await panel.getByLabel('Message au coach').fill('Mon prochain message reste ici.');
      await page.reload();
      if (!(await panel.isVisible())) await open.click();
      await expect(panel.getByLabel('Minutes disponibles')).toBeVisible();
      expect(stream.requests()).toBe(1);
      expect(resumes).toBe(0);
      await expect(panel.getByLabel('Message au coach')).toHaveValue('Mon prochain message reste ici.');
      await panel.getByLabel('Minutes disponibles').fill('25');
      await panel.getByRole('button', { name: 'Envoyer la réponse', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText('Réponse non enregistrée');
      await expect(panel.getByLabel('Minutes disponibles')).toHaveValue('25');
      await panel.getByLabel('Minutes disponibles').fill('30');
      await panel.getByRole('button', { name: 'Envoyer la réponse', exact: true }).click();
      await expect(panel.getByText('Réponse enregistrée.', { exact: true })).toBeVisible();
      expect(resumes).toBe(0);
      await page.screenshot({ path: `../.context/chat-human-${theme}-${width}.png`, animations: 'disabled' });
      await panel.getByRole('button', { name: 'Reprendre', exact: true }).click();
      await expect(panel.getByText('Ta séance de 30 minutes est prête.', { exact: true })).toBeVisible();
      expect(resumes).toBe(1);
      expect(item.decision).toEqual({ minutes: 30 });
      await expect(panel.getByLabel('Message au coach')).toHaveValue('Mon prochain message reste ici.');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await stream.close(); }
  });
}
