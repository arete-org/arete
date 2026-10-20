import { expect, test, type Page } from '@playwright/test';
import { coachStream } from './coachStream';

/** Visible text plus the names a screen reader announces: labels, placeholders, titles. */
const spoken = (page: Page) => page.evaluate(() => [
  document.body.innerText,
  ...[...document.querySelectorAll('[aria-label], [placeholder], [title]')].flatMap(el =>
    ['aria-label', 'placeholder', 'title'].map(name => el.getAttribute(name) ?? '')),
].join('\n'));

/** Classic mode says « le coach » as a common noun: never Chiron, never « Coach » as a name. */
async function expectClassicWords(page: Page) {
  const text = await spoken(page);
  expect(text).not.toContain('Chiron');
  expect(text).not.toMatch(/(?:^|\s)(?:à|avec|de|par) Coach\b/m);
}

// Chiron belongs to the RPG experience (ARE-134).
for (const rpg of [false, true]) {
  const words = rpg
    ? { ask: 'Demander à Chiron', title: 'Chiron', evening: 'Le soir, Chiron t’écrit' }
    : { ask: 'Demander au coach', title: 'Coach', evening: 'Le soir, le coach t’écrit' };
  test(`the coach is named ${rpg ? 'Chiron with' : 'le coach without'} the RPG opt-in`, async ({ page }) => {
    const stream = await coachStream(page, rpg, 'floating');
    try {
      await page.goto('/planning?date=2026-10-10');
      const launcher = page.getByRole('button', { name: words.ask, exact: true });
      await expect(launcher).toBeVisible();
      await launcher.click();
      const panel = page.getByRole('complementary', { name: 'Coach IA' });
      await expect(panel.getByRole('heading', { name: words.title, exact: true })).toBeVisible();
      await expect(panel.getByLabel('Message au coach')).toHaveAttribute('placeholder', `${words.ask}…`);
      if (!rpg) await expectClassicWords(page);
      await page.goto('/settings?tab=coach');
      await expect(page.getByRole('heading', { name: 'Réglages', exact: true })).toBeVisible();
      await expect(page.getByText(words.evening, { exact: false })).toBeVisible();
      if (rpg) expect(await spoken(page)).toContain('Chiron');
      else await expectClassicWords(page);
    } finally {
      await stream.close();
    }
  });
}
