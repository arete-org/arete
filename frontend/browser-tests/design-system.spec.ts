import { expect, test, type Page } from '@playwright/test';
import { THEMES } from '../src/lib/theme';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

async function settingsWith(page: Page, theme: string) {
  const counts = { writes: 0, refreshes: 0 };
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    if (path === '/api/garmin/sync/ensure') {
      counts.refreshes++;
      return route.fulfill({ json: { state: 'disconnected' } });
    }
    if (route.request().method() !== 'GET') counts.writes++;
    if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, theme } });
    if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, available: true } });
    return route.fulfill({ json: [] });
  });
  return counts;
}

// Exercise the CSS cascade in a browser: jsdom does not resolve theme variables.
for (const width of [390, 430, 768, 1440]) {
  test(`the kept themes preserve identity and usable appearance controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const counts = await settingsWith(page, 'pierre');
    await page.goto('/settings?tab=appearance');
    const choices = page.getByRole('group', { name: 'Thème', exact: true });
    // Four palettes and « Système »; no retired theme remains selectable.
    await expect(choices.getByRole('button')).toHaveCount(THEMES.length + 1);
    for (const retired of ['Clair', 'Sombre', 'Plus sombre', 'Abysse', 'Performance']) {
      await expect(choices.getByRole('button', { name: retired, exact: true })).toHaveCount(0);
    }

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
    expect(counts.writes).toBe(0);
    expect(counts.refreshes).toBe(1);
    await page.getByRole('button', { name: /^(Ouvrir le coach|Demander à Coach)$/ }).filter({ visible: true }).first().click();
    const panel = page.getByRole('complementary', { name: 'Coach IA' });
    await expect(panel.locator('.coach-title')).toHaveCSS('font-family', /Cormorant Garamond/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await panel.getByLabel('Message au coach').fill('Mon brouillon');
    await panel.getByRole('button', { name: 'Masquer le coach' }).click();
    await choices.getByRole('button', { name: 'Prune', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'prune');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'pierre');
    await expect(choices.getByRole('button', { name: 'Pierre', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });
}

/** WCAG relative luminance of a computed `rgb(…)` colour. */
function luminance(rgb: string) {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number).map(channel => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

test('every kept theme keeps text, accents, signals and chart series at WCAG AA', async ({ page }) => {
  await settingsWith(page, 'pierre');
  await page.goto('/settings?tab=appearance');
  const text = ['--ink-primary', '--ink-secondary', '--ink-muted', '--accent', '--accent-secondary', '--accent-tertiary',
    '--signal-success', '--signal-warning', '--signal-danger', '--signal-info', '--brand-strava',
    '--color-chart-blue', '--color-chart-green', '--color-chart-yellow', '--color-chart-orange', '--color-chart-red', '--color-chart-grey'];
  const grounds = ['--surface-page', '--surface-card', '--surface-raised'];
  const pairs = [['--ink-on-accent', '--accent'], ['--ink-on-accent-secondary', '--accent-secondary'], ['--accent', '--surface-selection']];
  for (const theme of THEMES) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme.value);
    // Resolve each token through a real property: custom properties keep their hex spelling.
    const colors = await page.evaluate(names => {
      const probe = document.body.appendChild(document.createElement('span'));
      const out = Object.fromEntries(names.map(name => {
        probe.style.color = `var(${name})`;
        return [name, getComputedStyle(probe).color];
      }));
      probe.remove();
      return out;
    }, [...new Set([...text, ...grounds, ...pairs.flat()])]);
    for (const fg of text) for (const bg of grounds) {
      expect(contrast(colors[fg], colors[bg]), `${theme.value}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const [fg, bg] of pairs) expect(contrast(colors[fg], colors[bg]), `${theme.value}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  }
});

test('« Système » follows the device: Pierre in light mode, Encre in dark mode, live', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await settingsWith(page, 'system');
  await page.goto('/settings?tab=appearance');
  const choices = page.getByRole('group', { name: 'Thème', exact: true });
  await expect(choices.getByRole('button', { name: 'Système', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'encre');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0E1413');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'pierre');
  // A chosen palette stops following the device until « Système » is chosen again.
  await choices.getByRole('button', { name: 'Odyssey', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'odyssey');
  await choices.getByRole('button', { name: 'Système', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'encre');
});

test('a fresh browser follows the device before the server answers', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await settingsWith(page, 'system');
  await page.route('**/api/settings', () => { /* never answers: only the browser decides */ });
  await page.goto('/settings?tab=appearance');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'encre');
  expect(await page.evaluate(() => localStorage.getItem('arete.theme.v1'))).toBeNull();
});

test('a cached retired theme migrates once on load', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('arete.theme.v1', 'abyss');
      sessionStorage.setItem('seeded', '1');
    }
  });
  await settingsWith(page, 'encre');
  await page.route('**/api/settings', () => { /* the browser's cache alone decides */ });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'encre');
  expect(await page.evaluate(() => localStorage.getItem('arete.theme.v1'))).toBe('encre');
});
