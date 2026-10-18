import { expect, test } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

for (const theme of ['pierre', 'prune']) for (const width of [390, 1440]) {
  test(`Suivi uses retained identity and shared menus · ${theme} · ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    const decisions: unknown[] = [];
    let answered = false;
    let responseAttempts = 0;
    let approved = false;
    let modelCalls = 0;
    const creations: unknown[] = [];
    const notices = [
      { id: 'question', title: 'Après ta sortie longue', body: 'Chiron attend ton ressenti.', url: '/follow-up?run=11111111-1111-4111-8111-111111111111' },
      { id: 'proposal', title: 'Alléger la séance de jeudi', body: '45 min → 30 min · endurance douce', url: '/follow-up?run=22222222-2222-4222-8222-222222222222' },
      { id: 'report', title: 'Ton bilan de la semaine', body: 'Bilan disponible.', url: '/follow-up?run=report' },
    ].map(item => ({ ...item, created_at: '2026-10-15T09:00:00Z', read_at: null, archived_at: null }));
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
      if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, theme } });
      if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, available: true } });
      if (path === '/api/garmin/sync/ensure') return route.fulfill({ json: { state: 'disconnected' } });
      if (path === '/api/garmin/planned') return route.fulfill({ json: [{ id: 42, date: '2026-10-18', sport: 'running', description: 'Sortie longue', target_duration_min: 90, status: 'pending' }] });
      if (path === '/api/coach/today') return route.fulfill({ json: { items: [], remaining: 0, briefing: null } });
      if (path === '/api/notifications') return route.fulfill({ json: { items: notices, unread: 2, next_offset: null } });
      if (path === '/api/agent/chat') { modelCalls += 1; return route.fulfill({ json: {} }); }
      if (path.endsWith('/interrupts/approval')) { decisions.push(route.request().postDataJSON()); approved = true; return route.fulfill({ json: {} }); }
      if (path === '/api/automation-runs/22222222-2222-4222-8222-222222222222') return route.fulfill({ json: { id: '22222222-2222-4222-8222-222222222222', state: approved ? 'ready' : 'waiting', due_at: '2026-10-15T09:00:00Z', definition: { title: 'Alléger la séance de jeudi' }, effects: [], interrupts: [{ id: 'approval', revision: 1, expires_at: '2099-10-16T09:00:00Z', decision: approved ? { type: 'approve' } : null, payload: { name: 'update_planned_session', args: { session_id: 42, changes: { target_duration_min: 30 } }, before: { target_duration_min: 45 } } }] } });
      if (path === '/api/automations' && route.request().method() === 'POST') { creations.push(route.request().postDataJSON()); return route.fulfill({ json: { id: 'created' } }); }
      if (path.endsWith('/interrupts/question')) { responseAttempts += 1; if (responseAttempts === 1) return route.fulfill({ status: 503, json: { detail: 'Réponse non enregistrée. Réessaie.' } }); decisions.push(route.request().postDataJSON()); answered = true; return route.fulfill({ json: {} }); }
      if (path === '/api/automation-runs/11111111-1111-4111-8111-111111111111') return route.fulfill({ json: { id: '11111111-1111-4111-8111-111111111111', state: answered ? 'ready' : 'waiting', due_at: '2026-10-15T09:00:00Z', definition: { title: 'Après ta sortie longue', mission: 'Préparer la suite de ton entraînement.' }, result: null, error: null, effects: [], interrupts: [{ id: 'question', revision: 1, expires_at: '2099-10-16T09:00:00Z', decision: answered ? { type: 'respond' } : null, payload: { name: 'ask_athlete', args: { question: 'Comment te sens-tu après cette séance ?' } } }] } });
      if (path === '/api/automations') return route.fulfill({ json: { items: [{ id: 'one', title: 'Bilan hebdomadaire', mission: 'Faire le point sur la charge et la récupération.', trigger: { kind: 'weekly', time: '18:00', weekdays: [6] }, timezone: 'Europe/Paris', state: 'active', revision: 1, next_due_at: '2026-10-18T16:00:00Z' }], next_offset: null } });
      return route.fulfill({ json: [] });
    });
    await page.goto('/follow-up');
    await page.getByRole('button', { name: /^(Ouvrir le coach|Demander à Chiron)$/ }).filter({ visible: true }).first().click();
    await page.getByLabel('Message au coach').fill('Mon brouillon à conserver.');
    await page.getByRole('button', { name: 'Masquer le coach', exact: true }).filter({ visible: true }).first().click();
    await page.getByRole('link', { name: /Après ta sortie longue/ }).click();
    await expect(page.getByRole('heading', { name: 'Suivi', exact: true })).toHaveCSS('font-family', /Cormorant Garamond/);
    const navigation = page.getByRole('navigation', { name: width < 768 ? 'Navigation mobile' : 'Navigation principale', exact: true });
    await expect(navigation.getByRole('link', { name: 'Planning', exact: true })).toBeVisible();
    await expect(navigation.getByRole('link', { name: 'Journal', exact: true })).toBeVisible();
    await expect(navigation.getByRole('link', { name: 'Réglages', exact: true })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Coach IA' })).toHaveCSS('border-radius', '16px');
    await expect(page.locator('.suivi-card .suivi-card')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel('Ta réponse').fill('Bonne récupération, jambes un peu lourdes.');
    await page.getByRole('button', { name: 'Envoyer la réponse', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus-visible')).toHaveCSS('outline-style', 'solid');
    if (width < 768) {
      await page.setViewportSize({ width, height: 500 });
      await expect(page.getByRole('button', { name: 'Envoyer la réponse', exact: true })).toBeInViewport();
      await page.setViewportSize({ width, height: 844 });
    }
    await page.getByLabel('Ta réponse').click();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `../.context/suivi-${theme}-${width}.png`, fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: 'Envoyer la réponse', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Réponse non enregistrée. Réessaie.');
    await expect(page.getByLabel('Ta réponse')).toHaveValue('Bonne récupération, jambes un peu lourdes.');
    expect(responseAttempts).toBe(1);
    await page.getByRole('button', { name: 'Envoyer la réponse', exact: true }).click();
    await expect(page.getByText('Réponse enregistrée.', { exact: true })).toBeVisible();
    expect(decisions).toEqual([{ revision: 1, decision: { type: 'respond', message: 'Bonne récupération, jambes un peu lourdes.' } }]);
    await page.getByRole('button', { name: 'Masquer le coach', exact: true }).filter({ visible: true }).first().click();
    await page.getByRole('link', { name: /Après ta sortie longue/ }).click();
    await expect(page.getByText('Réponse enregistrée.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Masquer le coach', exact: true }).filter({ visible: true }).first().click();
    await page.getByRole('link', { name: /Alléger la séance de jeudi/ }).click();
    const panel = page.getByRole('complementary', { name: 'Coach IA' });
    await expect(panel.getByRole('region', { name: 'Proposition du suivi' })).toContainText('45 → 30');
    await page.screenshot({ path: `../.context/validation-${theme}-${width}.png`, animations: 'disabled' });
    await panel.getByRole('button', { name: 'Approuver', exact: true }).click();
    await expect(panel.getByText('Décision enregistrée.', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'En parler à Chiron ↗' }).click();
    await expect(page.getByLabel('Message au coach')).toHaveValue('Mon brouillon à conserver.');
    expect(modelCalls).toBe(0);
    await page.getByRole('button', { name: 'Masquer le coach', exact: true }).filter({ visible: true }).first().click();
    await page.getByRole('button', { name: 'Routines', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Bilan hebdomadaire', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Créer une routine' }).click();
    await expect(page.getByLabel('Mission', { exact: true })).toBeVisible();
    await page.getByLabel('Titre', { exact: true }).fill('Mon bilan');
    await page.getByLabel('Mission', { exact: true }).fill('Examiner ma récupération.');
    await page.getByLabel('Déclencheur', { exact: true }).selectOption('session');
    await page.getByLabel('Séance', { exact: true }).selectOption('planned:42');
    await page.getByRole('button', { name: 'Activer ce suivi', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Créer une routine' })).toBeVisible();
    expect(creations).toHaveLength(1);
    expect(creations[0]).toMatchObject({ trigger: { kind: 'session', session_key: 'planned:42' }, activate: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
