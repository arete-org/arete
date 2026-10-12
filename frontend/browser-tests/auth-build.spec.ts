import { test, expect } from '@playwright/test';

// The second dev server (playwright.config.ts) is built with VITE_AUTH_ENABLED
// and a publishable key for clerk.arete.test, a host stubbed here: Clerk's
// script is replaced by a minimal signed-out instance, no network leaves.
test.use({ baseURL: 'http://127.0.0.1:5180' });

const SIGNED_OUT_CLERK = `
(() => {
  const resources = { client: { sessions: [], signedInSessions: [] }, session: null, user: null, organization: null };
  window.Clerk = {
    loaded: false,
    client: resources.client,
    session: null,
    user: null,
    organization: null,
    isSignedIn: false,
    frontendApi: 'clerk.arete.test',
    instanceType: 'development',
    __internal_lastEmittedResources: resources,
    async load() { this.loaded = true; },
    addListener(listener) { listener(resources); return () => {}; },
    mountSignIn(node) { node.innerHTML = '<p>Formulaire Clerk simulé</p>'; },
    unmountSignIn() {},
  };
})();`;

test('the sign-in page shows while the API is still cold', async ({ page }) => {
  const api: string[] = [];
  await page.route('**/api/**', async (route) => {
    api.push(new URL(route.request().url()).pathname);
    // A cold function instance: nothing answers for ten seconds.
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    await route.fulfill({ status: 503, json: { detail: 'cold' } }).catch(() => {});
  });
  await page.route('https://clerk.arete.test/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/clerk.browser.js')) {
      return route.fulfill({ contentType: 'application/javascript', body: SIGNED_OUT_CLERK });
    }
    if (path.endsWith('/ui.browser.js')) {
      return route.fulfill({
        contentType: 'application/javascript',
        body: 'window.__internal_ClerkUICtor = function ClerkUI() {};',
      });
    }
    return route.fulfill({ status: 404, body: '' });
  });

  const started = Date.now();
  await page.goto('/');
  await expect(page.getByText('Connecte-toi pour retrouver ton entraînement.')).toBeVisible();
  await expect(page.getByText('Formulaire Clerk simulé')).toBeVisible();
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(api).not.toContain('/api/auth/config');
});
