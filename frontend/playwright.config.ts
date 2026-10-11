import { defineConfig } from '@playwright/test';

/** A second dev server built with sign-in on, for `auth-build.spec.ts` (its Clerk host is stubbed). */
const CLERK_BUILD_URL = 'http://127.0.0.1:5180';
const CLERK_BUILD_KEY = `pk_test_${Buffer.from('clerk.arete.test$').toString('base64')}`;

export default defineConfig({
  testDir: './browser-tests',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  outputDir: '../.context/browser-results',
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5179', locale: 'fr-FR', viewport: { width: 1440, height: 1100 }, headless: true, screenshot: 'only-on-failure' },
  webServer: [
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5179 --strictPort',
      url: 'http://127.0.0.1:5179',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5180 --strictPort',
      url: CLERK_BUILD_URL,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { VITE_AUTH_ENABLED: 'true', VITE_CLERK_PUBLISHABLE_KEY: CLERK_BUILD_KEY },
    },
  ],
});
