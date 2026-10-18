import { isCancellation, reportRequest } from './connectivity';
import { claimPushDevice } from './pushSession';
import { clearPersistedQueries } from './queryPersistence';
/**
 * Session tokens for the API transports.
 *
 * Sign-in is optional server-side (`GET /api/auth/config`, or the build's
 * `VITE_AUTH_ENABLED`, see components/auth/buildConfig.ts). When it is on, the
 * auth gate registers Clerk's `getToken` here and every `/api/` request carries
 * `Authorization: Bearer <token>`; when it is off nothing is registered and the
 * requests go out exactly as before. The Clerk SDK itself never enters this
 * module, so the main bundle stays free of it.
 */

export type TokenGetter = () => Promise<string | null>;

/** The service worker's cache of API answers (src/sw.ts). */
export const API_CACHE_NAME = 'api-cache';

let tokenGetter: TokenGetter | null = null;
let unauthorizedHandler: (() => void) | null = null;

/** Registers the function that yields the current session token; null forgets it. */
export function setTokenGetter(getter: TokenGetter | null): void {
  tokenGetter = getter;
}

/**
 * Registers what to do when the server answers 401 while a session is expected.
 * Returns the function that unregisters it.
 */
export function onUnauthorized(handler: () => void): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

/** `{ Authorization }` for the current session; empty without a getter or a token. */
export async function authHeaders(): Promise<Record<string, string>> {
  if (!tokenGetter) return {};
  const token = await tokenGetter();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** A 401 only means a lost session when one was expected: without a getter there is nothing to do. */
export function reportUnauthorized(): void {
  if (tokenGetter) unauthorizedHandler?.();
}

/** `fetch` with the session header; a 401 reports the lost session before returning. */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(await authHeaders())) headers.set(name, value);
  let response: Response;
  try {
    response = await fetch(input, { ...init, headers });
  } catch (error) {
    // Only a request that never got an answer tells the banner the server is out of reach.
    if (!isCancellation(error)) reportRequest(false);
    throw error;
  }
  reportRequest(true);
  if (response.status === 401) reportUnauthorized();
  return response;
}

/** Drops every cached answer, the service worker's and the persisted query cache,
 *  so the next account on this browser never reads this one's data. */
export async function clearSignedOutCaches(): Promise<void> {
  await Promise.all([clearApiCache(), clearPersistedQueries()]);
}

/** Drops the cached API answers so the next account never reads this one's data. */
export async function clearApiCache(): Promise<void> {
  // Absent outside secure contexts and in unsupported browsers.
  if (typeof caches === 'undefined') return;
  await caches.delete(API_CACHE_NAME);
}

/**
 * Ends the session: Clerk's sign-out, then `reset` (in-memory caches), then the
 * cached and persisted answers, then a reload so the page restarts signed out with nothing left over.
 * The cleanup runs as Clerk's sign-out callback, in place of its own navigation.
 * A failed sign-out leaves everything in place for the caller to report.
 */
export async function endSession(
  signOut: (then: () => Promise<void>) => Promise<unknown>,
  reset?: () => void
): Promise<void> {
  let cleaned = false;
  const cleanup = async () => {
    cleaned = true;
    setTokenGetter(null);
    reset?.();
    await clearSignedOutCaches();
    await claimPushDevice(null);
    window.location.reload();
  };
  await signOut(cleanup);
  // Clerk skips the callback when it holds no session: still leave a clean page.
  if (!cleaned) await cleanup();
}
