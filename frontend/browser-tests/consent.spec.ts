import { test, expect } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/pages/settings/types';

// The dev server built with sign-in on (playwright.config.ts). Clerk's script is
// replaced by a minimal signed-in instance on a stubbed host: no network leaves.
test.use({ baseURL: 'http://127.0.0.1:5180' });

const SIGNED_IN_CLERK = `
(() => {
  const user = { id: 'user_ana', primaryEmailAddress: { emailAddress: 'ana@exemple.fr' }, externalAccounts: [], organizationMemberships: [] };
  const session = { id: 'sess_ana', status: 'active', user, actor: null, factorVerificationAge: null, lastActiveToken: { jwt: { claims: { sub: 'user_ana', sid: 'sess_ana' } } }, async getToken() { return 'jeton'; } };
  const resources = { client: { sessions: [session], signedInSessions: [session], lastActiveSessionId: session.id }, session, user, organization: null };
  window.Clerk = {
    loaded: false,
    client: resources.client,
    session,
    user,
    organization: null,
    isSignedIn: true,
    frontendApi: 'clerk.arete.test',
    instanceType: 'development',
    __internal_lastEmittedResources: resources,
    async load() { this.loaded = true; },
    addListener(listener) { listener(resources); return () => {}; },
    async signOut() {},
    mountUserButton(node) { node.textContent = 'Compte'; },
    unmountUserButton() {},
  };
})();`;

const VERSION = '2026-10-draft-1';
const NOT_GIVEN = { required: true, current: false, terms_version: VERSION, privacy_version: VERSION, latest: null };
const GIVEN = {
  ...NOT_GIVEN,
  current: true,
  latest: { terms_version: VERSION, privacy_version: VERSION, health_data: true, consented_at: '2026-10-18T08:30:00Z', withdrawn_at: null },
};

test('a fresh account sees the texts and cannot reach the app before consenting', async ({ page }) => {
  let consent: typeof NOT_GIVEN | typeof GIVEN = NOT_GIVEN;
  const before: string[] = [];
  const answers: unknown[] = [];
  await page.route('https://clerk.arete.test/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/clerk.browser.js')) {
      return route.fulfill({ contentType: 'application/javascript', body: SIGNED_IN_CLERK });
    }
    if (path.endsWith('/ui.browser.js')) {
      return route.fulfill({ contentType: 'application/javascript', body: 'window.__internal_ClerkUICtor = function ClerkUI() {};' });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!consent.current) before.push(`${request.method()} ${path}`);
    if (path === '/api/auth/me') {
      return route.fulfill({
        json: { email: 'ana@exemple.fr', name: 'Ana', athlete_id: 2, is_owner: false, role: 'athlete', is_admin: false, consent },
      });
    }
    if (path === '/api/auth/consent' && request.method() === 'POST') {
      answers.push(request.postDataJSON());
      consent = GIVEN;
      return route.fulfill({ json: GIVEN });
    }
    if (!consent.current) {
      // What the server answers before consent, whatever the route.
      return route.fulfill({ status: 403, json: { detail: 'Accepte les conditions…' } });
    }
    if (path === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SETTINGS, user_id: 2 } });
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], unread: 0, next_offset: null } });
    return route.fulfill({ status: 503, json: { detail: 'indisponible' } });
  });

  await page.goto('/');
  await expect(page.getByText(/rien n’est synchronisé, analysé ni envoyé au coach/)).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toHaveCount(0);

  // Both texts are readable in place, and nothing is ticked for the athlete.
  await page.getByRole('button', { name: 'Lire : Politique de confidentialité' }).click();
  await expect(page.getByRole('region', { name: 'Politique de confidentialité' }).getByText('BROUILLON — à valider')).toBeVisible();
  const terms = page.getByRole('checkbox', { name: /J’ai lu et j’accepte les conditions/ });
  const health = page.getByRole('checkbox', { name: /article 9 du RGPD/ });
  await expect(terms).not.toBeChecked();
  await expect(health).not.toBeChecked();
  const accept = page.getByRole('button', { name: /Accepter et continuer/ });
  await expect(accept).toBeDisabled();
  await terms.check();
  await expect(accept).toBeDisabled();
  await health.check();
  await page.screenshot({ path: '../.context/consent-gate.png', fullPage: true, animations: 'disabled' });

  // Nothing but the account was asked before the athlete agreed.
  expect(before).toEqual(['GET /api/auth/me']);
  await accept.click();
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible();
  await expect(page.getByText(/rien n’est synchronisé, analysé ni envoyé au coach/)).toHaveCount(0);
  expect(answers).toEqual([{ terms_version: VERSION, privacy_version: VERSION, terms_accepted: true, health_data: true }]);
});
