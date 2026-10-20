import { expect, test, type Page } from '@playwright/test';
import { coachStream } from './coachStream';

/** Visible text plus the names a screen reader announces: labels, placeholders, titles. */
const spoken = (page: Page) => page.evaluate(() => [
  document.body.innerText,
  ...[...document.querySelectorAll('[aria-label], [placeholder], [title]')].flatMap(el =>
    ['aria-label', 'placeholder', 'title'].map(name => el.getAttribute(name) ?? '')),
].join('\n'));

// Chiron belongs to the RPG experience (ARE-134): classic mode always says « Coach ».
for (const rpg of [false, true]) {
  const name = rpg ? 'Chiron' : 'Coach';
  test(`the coach is named ${name} ${rpg ? 'with' : 'without'} the RPG opt-in`, async ({ page }) => {
    const stream = await coachStream(page, rpg, 'floating');
    try {
      await page.goto('/planning?date=2026-10-10');
      const launcher = page.getByRole('button', { name: `Demander à ${name}`, exact: true });
      await expect(launcher).toBeVisible();
      await launcher.click();
      const panel = page.getByRole('complementary', { name: 'Coach IA' });
      await expect(panel.getByRole('heading', { name, exact: true })).toBeVisible();
      await expect(panel.getByLabel('Message au coach')).toHaveAttribute('placeholder', `Demander à ${name}…`);
      if (!rpg) expect(await spoken(page)).not.toContain('Chiron');
      await page.goto('/settings?tab=coach');
      await expect(page.getByRole('heading', { name: 'Réglages', exact: true })).toBeVisible();
      await expect(page.getByText(`Le soir, ${name} t’écrit`, { exact: false })).toBeVisible();
      if (rpg) expect(await spoken(page)).toContain('Chiron');
      else expect(await spoken(page)).not.toContain('Chiron');
    } finally {
      await stream.close();
    }
  });
}
