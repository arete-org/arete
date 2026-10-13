import { expect, test } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

for (const rpg of [false, true]) {
  test(`slash skill selection, draft persistence and send (${rpg ? 'Chiron' : 'Arete'})`, async ({ page }) => {
    const sent: { messages: { role: string; content: string }[] }[] = [];
    let catalogs = 0;
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
      if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, theme: 'pierre' } });
      if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: rpg, opted_in: rpg, available: true, version: 1 } });
      if (path === '/api/agent/skills') {
        catalogs++;
        return route.fulfill({ json: [{ name: 'document-planning', description: 'Consulter un planning joint pour un jour ou une semaine.', path: '/skills/system/document-planning/SKILL.md' }] });
      }
      if (path === '/api/agent/chat/stream') {
        sent.push(route.request().postDataJSON());
        return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"done","message":{"role":"assistant","content":"Skill chargé."}}\n\n' });
      }
      if (path.includes('/settings')) return route.fulfill({ json: {} });
      return route.fulfill({ json: [] });
    });
    await page.goto('/planning?date=2026-10-10');
    const open = () => page.getByRole('button', { name: /^(Ouvrir le coach|Demander à Chiron)$/ }).filter({ visible: true }).first().click();
    await open();
    const panel = page.getByRole('complementary', { name: 'Coach IA' });
    const input = panel.getByLabel('Message au coach');
    expect(catalogs).toBe(0);
    await input.fill('/');
    await expect(panel.getByRole('option')).toBeVisible();
    expect(sent).toHaveLength(0);
    await input.press('Escape');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('listbox')).toHaveCount(0);
    await input.fill('/doc');
    await panel.screenshot({ path: `../.context/skills-${rpg ? 'chiron' : 'arete'}-desktop.png` });
    await input.press('Enter');
    await expect(input).toHaveValue('/document-planning ');
    expect(sent).toHaveLength(0);
    // The selected command lives in the normal draft: switching and reload keep it.
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.reload();
    await open();
    await expect(input).toHaveValue('/document-planning ');
    await page.setViewportSize({ width: 390, height: 844 });
    await input.fill('/doc');
    await expect(panel.getByRole('option')).toBeInViewport();
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await panel.screenshot({ path: `../.context/skills-${rpg ? 'chiron' : 'arete'}-mobile.png` });
    await panel.getByRole('option').click();
    await expect(input).toHaveValue('/document-planning ');
    await input.press('End');
    await input.pressSequentially('Vérifie samedi.');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].messages.at(-1)?.content).toBe('/document-planning Vérifie samedi.');
    await expect(panel.getByLabel('Ton message')).toContainText('/document-planning Vérifie samedi.');
    await expect(panel.getByText('Skill chargé.', { exact: true })).toBeVisible();
  });
}
