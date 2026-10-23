import type { AuthConfig } from '@/lib/api';

/**
 * Sign-in as the build knows it: `VITE_AUTH_ENABLED=true` with
 * `VITE_CLERK_PUBLISHABLE_KEY`, set per deployment. The gate then starts Clerk
 * without asking `GET /api/auth/config` first, which a cold backend delays.
 *
 * Only `true` with a key counts: anything else (unset, as in a self-hosted
 * build, or the flag without its key) means "ask the server", which a reload
 * could never fix in the build. The build can therefore add sign-in, never
 * remove it, and the API refuses unauthenticated requests whatever this says.
 */
export function buildAuthConfig(): AuthConfig | null {
  const env = import.meta.env;
  if (String(env.VITE_AUTH_ENABLED ?? '').trim().toLowerCase() !== 'true') return null;
  const key = String(env.VITE_CLERK_PUBLISHABLE_KEY ?? '').trim();
  return key ? { enabled: true, publishable_key: key } : null;
}
