import { expect, test } from '@playwright/test';

const thread = 'dddddddd-1234-4123-8123-123456789012';
const trace = { trace_id: '12345678-1234-4123-8123-123456789012', feedback_token: 'a'.repeat(64) };
const answer = 'Garde une sortie facile aujourd’hui. Ta charge est déjà élevée cette semaine : 35 minutes en aisance respiratoire suffisent. On garde l’intensité pour jeudi.';

for (const rpg of [false, true]) {
  test(`feedback per answer, reload and uncertain writes (${rpg ? 'Chiron' : 'Arete'})`, async ({ page }) => {
    let score: number | null = null;
    let reaction: string | null = null;
    let failNext = false;
    const writes: { key: string; value: unknown }[] = [];
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
      if (path.endsWith('/auth/config')) return route.fulfill({ json: { enabled: false } });
      if (path.endsWith('/settings/gamification')) return route.fulfill({ json: { enabled: rpg, opted_in: rpg, available: true, version: 1 } });
      if (path.includes('/agent/feedback/')) {
        expect(path).toContain(trace.trace_id);
        const body = route.request().postDataJSON();
        expect(body.thread_id).toBe(thread);
        expect(body.feedback_token).toBe(trace.feedback_token);
        if (path.endsWith('/read')) return route.fulfill({ json: { user_score: score, reaction } });
        writes.push(body);
        if (body.key === 'user_score') score = body.value;
        else reaction = body.value;
        if (failNext) { failNext = false; return route.fulfill({ status: 502, json: { detail: 'Uncertain' } }); }
        return route.fulfill({ status: 204 });
      }
      if (path.includes('/settings')) return route.fulfill({ json: {} });
      return route.fulfill({ json: [] });
    });
    await page.goto('/planning?date=2026-10-10');
    await page.evaluate(({ thread, trace, answer }) => {
      localStorage.setItem('arete.coach.threads.v1', JSON.stringify({ version: 1, activeId: thread, threads: [{
        id: thread, title: 'La séance du jour', createdAt: Date.now(), updatedAt: Date.now(), draft: '',
        messages: [{ role: 'assistant', content: 'Ancienne réponse sans trace.' }, { role: 'user', content: 'Quelle séance pour aujourd’hui ?' }, { role: 'assistant', content: answer, trace }],
      }] }));
    }, { thread, trace, answer });
    await page.reload();
    const open = () => page.getByRole('button', { name: /^(Ouvrir le coach|Demander à Chiron)$/ }).filter({ visible: true }).first().click();
    await open();
    const panel = page.getByRole('complementary', { name: 'Coach IA' });
    await expect(panel).toHaveCSS('opacity', '1');
    await expect(panel.getByRole('button', { name: 'Réponse utile', exact: true })).toHaveCount(1);
    await panel.getByRole('button', { name: 'Réponse utile', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Réponse utile', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await panel.getByRole('button', { name: 'Choisir une réaction' }).click();
    await panel.getByRole('textbox', { name: 'Ou colle ton emoji' }).fill('👩🏽‍💻');
    await panel.getByRole('button', { name: 'Ajouter la réaction' }).click();
    await expect(panel.getByRole('button', { name: 'Retirer la réaction 👩🏽‍💻' })).toBeVisible();
    await panel.getByRole('button', { name: 'Choisir une réaction' }).click();
    await panel.screenshot({ path: `../.context/feedback-${rpg ? 'chiron' : 'arete'}-desktop.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.getByRole('button', { name: 'Ajouter la réaction' }).scrollIntoViewIfNeeded();
    await expect(panel.getByRole('button', { name: 'Ajouter la réaction' })).toBeInViewport();
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await panel.screenshot({ path: `../.context/feedback-${rpg ? 'chiron' : 'arete'}-mobile.png` });
    await panel.getByRole('textbox', { name: 'Ou colle ton emoji' }).press('Escape');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('textbox', { name: 'Ou colle ton emoji' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Choisir une réaction' })).toBeFocused();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.reload();
    await open();
    await expect(panel.getByRole('button', { name: 'Réponse utile', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByRole('button', { name: 'Retirer la réaction 👩🏽‍💻' })).toBeVisible();
    expect(writes).toHaveLength(2);
    failNext = true;
    await panel.getByRole('button', { name: 'Réponse peu utile', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Réponse utile', exact: true })).toBeDisabled();
    await panel.getByRole('button', { name: 'Vérifier le retour enregistré' }).click();
    await expect(panel.getByRole('button', { name: 'Réponse peu utile', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(writes).toHaveLength(3);
    await panel.getByRole('button', { name: 'Retirer la réaction 👩🏽‍💻' }).click();
    await expect(panel.getByRole('button', { name: 'Retirer la réaction 👩🏽‍💻' })).toHaveCount(0);
    expect(writes.at(-1)).toMatchObject({ key: 'reaction', value: null });
  });
}
