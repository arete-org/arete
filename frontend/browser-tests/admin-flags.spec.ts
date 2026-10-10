import { expect, test } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

for (const mobile of [false, true]) {
  test(`admin GLM rollout persists, reverts and reports failure (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
    let enabled = false;
    let refuse = false;
    const writes: boolean[] = [];
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/auth/config') return route.fulfill({ json: { enabled: false } });
      if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 1, theme: 'pierre' } });
      if (path === '/api/settings/gamification') return route.fulfill({ json: { enabled: false, opted_in: false, available: true, version: 1 } });
      if (path === '/api/admin/feature-flags') {
        if (route.request().method() === 'PUT') {
          if (refuse) return route.fulfill({ status: 409, json: { detail: 'OpenRouter indisponible.' } });
          enabled = route.request().postDataJSON().glm_flash;
          writes.push(enabled);
        }
        return route.fulfill({ json: { glm_flash: enabled, glm_flash_available: true } });
      }
      return route.fulfill({ json: [] });
    });
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/settings?tab=admin');
    const toggle = page.getByRole('checkbox', { name: 'Coach GLM Flash (payant)' });
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    // Saved state changes only after the server responds, not on the click.
    await toggle.click();
    await expect(page.getByText('Option enregistrée.')).toBeVisible();
    await page.reload();
    await expect(toggle).toBeChecked();
    await page.screenshot({ path: `../.context/glm-admin-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true, animations: 'disabled' });
    if (!mobile) {
      await page.getByRole('heading', { name: 'FONCTIONNALITÉS EXPÉRIMENTALES' }).locator('..').screenshot({ path: '../.context/glm-admin-panel.png', animations: 'disabled' });
    }
    await toggle.click();
    await expect(page.getByText('Option enregistrée.')).toBeVisible();
    await expect(toggle).not.toBeChecked();
    expect(writes).toEqual([true, false]);
    refuse = true;
    await toggle.click();
    await expect(page.getByRole('alert')).toHaveText('OpenRouter indisponible.');
    await expect(toggle).not.toBeChecked();
  });
}
