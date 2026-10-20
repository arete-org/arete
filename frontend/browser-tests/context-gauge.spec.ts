import { expect, test, type Page } from '@playwright/test';
import { coachStream } from './coachStream';

async function openCoach(page: Page, query = '?contextGaugeAlways=false') {
  await page.goto(`/planning${query}`);
  await page.getByRole('button', { name: /^(Ouvrir le coach|Demander (?:au coach|à Chiron))$/ }).filter({ visible: true }).first().click();
  return page.getByRole('complementary', { name: 'Coach IA' });
}

test('context gauge follows SSE, survives reload and fits both chat themes on mobile', async ({ page }) => {
  const stream = await coachStream(page, false, 'floating');
  try {
    let panel = await openCoach(page);
    const footer = panel.locator('footer');
    await expect(footer.getByRole('button', { name: /Contexte/ })).toHaveCount(0);
    await panel.getByRole('textbox', { name: 'Message au coach' }).fill('On prépare la semaine ?');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect.poll(() => stream.requests()).toBe(1);
    stream.send({ type: 'values', context_window_usage: { used_tokens: 20972, window_tokens: 65536 } });
    const gauge = footer.getByRole('button', { name: 'Contexte · 32 %' });
    await expect(gauge).toBeVisible();
    await gauge.focus();
    await expect(footer.getByRole('tooltip')).toContainText('20 972 / 65 536 tokens');
    await page.keyboard.press('Escape');
    await expect(footer.getByRole('tooltip')).toHaveCount(0);
    await panel.getByRole('textbox', { name: 'Message au coach' }).fill('Mon prochain message');
    stream.send({ type: 'values', context_window_usage: { used_tokens: 57672, window_tokens: 65536 } });
    stream.send({ type: 'context_compaction', phase: 'start' });
    await expect(footer.getByRole('button', { name: 'Compaction…' })).toBeVisible();
    await page.screenshot({ path: '../.context/context-gauge-desktop.png' });
    await panel.screenshot({ path: '../.context/context-gauge-chat.png' });
    for (const theme of ['pierre', 'prune']) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
      await expect(footer.getByRole('button', { name: 'Compaction…' })).toBeInViewport();
      await expect(footer.getByRole('button', { name: 'Arrêter la réponse' })).toBeInViewport();
      expect(await footer.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: `../.context/context-gauge-${theme}-mobile.png` });
    }
    stream.send({ type: 'context_compaction', phase: 'done' });
    await expect(footer.getByRole('button', { name: 'Contexte · 88 %' })).toBeVisible();
    stream.send({ type: 'done', message: { role: 'assistant', content: 'Prêt pour la suite.' } });
    await expect(panel.getByRole('button', { name: 'Arrêter la réponse' })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('arete.coach.threads.v1')!).threads[0].contextWindowUsage?.used_tokens)).toBe(57672);
    panel = await openCoach(page, '');
    await expect(panel.getByRole('button', { name: 'Contexte · 88 %' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Compaction…' })).toHaveCount(0);
    await expect(panel.getByRole('textbox', { name: 'Message au coach' })).toHaveValue('Mon prochain message');
    expect(stream.requests()).toBe(1);
  } finally { await stream.close(); }
});

test('without the URL flag a low gauge only appears during compaction and clears on stop', async ({ page }) => {
  const stream = await coachStream(page, false, 'floating');
  try {
    const panel = await openCoach(page, '');
    await panel.getByRole('textbox', { name: 'Message au coach' }).fill('Question');
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await expect.poll(() => stream.requests()).toBe(1);
    stream.send({ type: 'values', context_window_usage: { used_tokens: 10, window_tokens: 1000 } });
    stream.send({ type: 'context_compaction', phase: 'start' });
    await expect(panel.getByRole('button', { name: 'Compaction…' })).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(panel.locator('footer .motion-safe\\:animate-pulse')).toHaveCSS('animation-name', 'none');
    await panel.getByRole('button', { name: 'Arrêter la réponse' }).click();
    await expect(panel.getByRole('button', { name: 'Compaction…' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /Contexte/ })).toHaveCount(0);
    expect(stream.requests()).toBe(1);
  } finally { await stream.close(); }
});
