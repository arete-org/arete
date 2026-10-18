/**
 * Whether the server can be reached, for the top banner: the browser's own
 * `navigator.onLine`, and the API requests themselves (a request that never
 * got an answer, or any answer after it). No polling and no extra request.
 */
export type Connectivity = 'online' | 'offline' | 'unreachable';

let failed = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

// Back online, the failures seen offline say nothing about the server: the
// next request tells. Registered before any banner listens, so it runs first.
if (typeof window !== 'undefined') window.addEventListener('online', () => { failed = false; });

export function connectivity(): Connectivity {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  return failed ? 'unreachable' : 'online';
}

/** An API request's outcome: `false` when it never reached the server. */
export function reportRequest(reached: boolean): void {
  if (failed === !reached) return;
  failed = !reached;
  changed();
}

/** A request the page cancelled (or that timed out by its own signal) says nothing about the network. */
export function isCancellation(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export function subscribeConnectivity(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}
