/**
 * Recovery when a deploy removed the chunks this page was built with.
 *
 * The service worker precaches only the shell (sw.ts): a page running an older
 * build asks for chunks the server no longer has, and the SPA rewrite answers
 * them with index.html, so the import fails. Reloading once, after the new worker
 * took over, loads the new build. A second failure soon after is a real error
 * and stays visible instead of looping.
 */
const KEY = 'arete.chunk-reload';
const LOOP_WINDOW_MS = 30_000;
const WORKER_WAIT_MS = 10_000;
let reloading = false;
let held = false;

/** A streaming coach run must not be cut by an automatic reload (useCoachThreads). */
export function holdReloads(active: boolean): void {
  held = active;
}

function claimReload(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY));
    if (last && Date.now() - last < LOOP_WINDOW_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
    return true;
  } catch {
    return false; // Without storage there is no loop guard: never reload automatically.
  }
}

/** The new build's worker serves the new index.html; an old one still controlling would not. */
async function newWorker(): Promise<void> {
  const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  if (!registration) return;
  await registration.update().catch(() => {});
  if (!registration.installing && !registration.waiting) return;
  await new Promise((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
    setTimeout(resolve, WORKER_WAIT_MS);
  });
}

/** Starts at most one reload; false when the error must surface instead. */
export function recoverFromStaleBuild(): boolean {
  if (reloading) return true;
  if (held || !claimReload()) return false;
  reloading = true;
  void newWorker().finally(() => window.location.reload());
  return true;
}

/** A lazy import that reloads onto the new build instead of failing, once. */
export function importChunk<T>(load: () => Promise<T>): () => Promise<T> {
  return () =>
    load().catch((error: unknown) => {
      // Keep the Suspense fallback on screen until the page reloads.
      if (recoverFromStaleBuild()) return new Promise<T>(() => {});
      throw error;
    });
}

/** Vite reports every failed dynamic import of the build (chunks loaded outside `importChunk` too). */
export function recoverChunkErrors(): void {
  window.addEventListener('vite:preloadError', () => {
    recoverFromStaleBuild();
  });
}
