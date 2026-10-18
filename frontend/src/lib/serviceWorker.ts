/**
 * New versions of the app (src/sw.ts). A new worker installs beside the one
 * serving the page and waits: the page announces it, and the athlete reloads
 * when it suits them (« Recharger »), so a reply being typed is never cut.
 */
const SKIP_WAITING = { type: 'SKIP_WAITING' } as const;
/** A long-open installed app checks again when brought back, at most hourly. */
const CHECK_EVERY_MS = 60 * 60_000;

function installed(worker: ServiceWorker): Promise<ServiceWorker | null> {
  return new Promise((resolve) => {
    const settle = () => {
      if (worker.state === 'installed') resolve(worker);
      else if (worker.state === 'redundant' || worker.state === 'activated') resolve(null);
      else return;
      worker.removeEventListener('statechange', settle);
    };
    worker.addEventListener('statechange', settle);
    settle();
  });
}

/**
 * Calls `onWaiting` once a new version waits (now or later). Only an update
 * waits: the very first install takes over at once. Returns the cleanup.
 */
export function watchForUpdate(onWaiting: (worker: ServiceWorker) => void): () => void {
  const container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  if (!container) return () => {};
  let stopped = false;
  let registration: ServiceWorkerRegistration | null = null;
  let lastCheck = Date.now();
  const report = (worker: ServiceWorker | null) => {
    if (worker && !stopped && container.controller) onWaiting(worker);
  };
  const found = () => {
    const worker = registration?.installing;
    if (worker) void installed(worker).then(report);
  };
  const visible = () => {
    if (document.visibilityState !== 'visible' || !registration || Date.now() - lastCheck < CHECK_EVERY_MS) return;
    lastCheck = Date.now();
    registration.update().catch(() => {});
  };
  void container.ready.then((ready) => {
    if (stopped) return;
    registration = ready;
    if (ready.waiting) report(ready.waiting);
    else if (ready.installing) found();
    ready.addEventListener('updatefound', found);
    document.addEventListener('visibilitychange', visible);
  });
  return () => {
    stopped = true;
    registration?.removeEventListener('updatefound', found);
    document.removeEventListener('visibilitychange', visible);
  };
}

/** Lets the waiting version take over; resolves once it controls the page, or after `timeoutMs`. */
export function activate(worker: ServiceWorker, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
    setTimeout(resolve, timeoutMs);
    worker.postMessage(SKIP_WAITING);
  });
}

/** The version waiting or still installing after a fresh check, if any. */
export async function pendingWorker(registration: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
  await registration.update().catch(() => {});
  if (registration.waiting) return registration.waiting;
  return registration.installing ? installed(registration.installing) : null;
}
