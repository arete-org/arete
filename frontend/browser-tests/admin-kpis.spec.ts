import { expect, test } from '@playwright/test';
import { KPI_KEYS, type KpiWeek } from '../src/lib/api';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

const week = (week_start: string, current: boolean, active: number): KpiWeek => ({
  week_start,
  current,
  indicators: Object.fromEntries(
    KPI_KEYS.map((key) => [key, { numerator: active, denominator: 4, value: active / 4 }])
  ) as KpiWeek['indicators'],
});
const WEEKS = [week('2026-10-12', true, 1), week('2026-10-05', false, 3)];

for (const mobile of [false, true]) {
  test(`admin product indicators: ${mobile ? 'stacked weeks on mobile' : 'a table on desktop'}, CSV export`, async ({ page }) => {
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
      if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
      if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, theme: 'pierre' } });
      if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, opted_in: false, available: true, version: 1 } });
      if (path === '/api/admin/feature-flags') return route.fulfill({ json: { glm_flash: false, glm_flash_available: true } });
      if (path === '/api/admin/kpis') return route.fulfill({ json: WEEKS });
      return route.fulfill({ json: [] });
    });
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/settings?tab=admin');

    await expect(page.getByRole('heading', { name: 'INDICATEURS PRODUIT' })).toBeVisible();
    const tiles = page.getByRole('list', { name: 'Semaine en cours' }).getByRole('listitem');
    await expect(tiles).toHaveCount(KPI_KEYS.length);
    await expect(tiles.first()).toContainText('Comptes actifs25 %1 / 4');
    const table = page.getByRole('table', { name: 'Indicateurs des 2 dernières semaines' });
    const stacked = page.getByRole('list', { name: 'Semaines' });
    if (mobile) {
      await expect(table).toBeHidden();
      await expect(stacked.getByRole('heading', { name: 'Semaine du 05/10/2026' })).toBeVisible();
      // The weeks fit the screen: nothing scrolls sideways.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    } else {
      await expect(stacked).toBeHidden();
      await expect(table.getByRole('rowheader', { name: '12/10/2026 (en cours)' })).toBeVisible();
    }

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'EXPORTER EN CSV' }).click();
    expect((await download).suggestedFilename()).toBe('arete-indicateurs-2026-10-12.csv');
  });
}
