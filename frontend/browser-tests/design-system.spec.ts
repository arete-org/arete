import { expect, test } from '@playwright/test';
import { THEMES } from '../src/lib/theme';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

// Exercise the CSS cascade in a browser: jsdom does not resolve theme variables.
for (const width of [390, 430, 768, 1440]) {
  test(`the eight themes preserve identity and usable appearance controls at ${width}px`, async ({ page }) => {
    let writes = 0;
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== 'GET') writes++;
      if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
      if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, theme: 'pierre' } });
      if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, available: true } });
      return route.fulfill({ json: [] });
    });
    await page.goto('/settings?tab=appearance');
    const choices = page.getByRole('group', { name: 'Thème', exact: true });
    await expect(choices.getByRole('button')).toHaveCount(THEMES.length);

    for (const theme of THEMES) {
      const choice = choices.getByRole('button', { name: theme.label, exact: true });
      await choice.click();
      await expect(choice).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme.value);
      await expect(page.getByRole('heading', { name: 'Réglages', exact: true })).toHaveCSS('font-family', /Cormorant Garamond/);
      await expect(choice).toHaveCSS('font-family', /Inter/);
      await expect(choice.locator('.arete-wordmark')).toHaveCSS('font-family', /Cormorant Garamond/);
      const palette = await page.locator('html').evaluate(el => ({
        color: getComputedStyle(el).color,
        background: getComputedStyle(el).backgroundColor,
      }));
      await expect(choice.locator('.theme-preview')).toHaveCSS('color', palette.color);
      await expect(choice.locator('.theme-preview')).toHaveCSS('background-color', palette.background);
      await expect(page.locator('.glass-panel').first()).toHaveCSS('border-radius', '16px');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await choice.focus();
      await page.keyboard.press('Shift+Tab');
      await expect(page.locator(':focus-visible')).toHaveCSS('outline-style', 'solid');
    }
    // Previewing themes is reversible and must never write a preference implicitly.
    expect(writes).toBe(0);
    await page.getByRole('button', { name: /^(Ouvrir le coach|Demander à Chiron)$/ }).filter({ visible: true }).first().click();
    const panel = page.getByRole('complementary', { name: 'Coach IA' });
    await expect(panel.locator('.coach-title')).toHaveCSS('font-family', /Cormorant Garamond/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await panel.getByLabel('Message au coach').fill('Mon brouillon');
    await panel.getByRole('button', { name: 'Masquer le coach' }).click();
    await choices.getByRole('button', { name: 'PRUNE', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'prune');
    await page.screenshot({ path: `../.context/are-33-revamp-${width}.png`, animations: 'disabled' });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'pierre');
    await expect(choices.getByRole('button', { name: 'PIERRE', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });
}
