/**
 * New versions of the app (src/sw.ts). A new worker installs beside the one
 * serving the page and waits. A page that loads while one waits takes it at
 * once (chunkReload.takeWaitingAtLoad); a page already open announces it, and
 * the athlete reloads when it suits them (« Recharger »), so a reply being
 * typed is never cut.
 */
const SKIP_WAITING = { type: 'SKIP_WAITING' } as const;
/** A long-open installed app checks again when brought back, at most hourly. */
const CHECK_EVERY_MS = 60 * 60_000;
/** Only the page's first look is "at load": a later watcher (a remounted notice) is mid-session. */
let firstCheck = true;

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
 * Calls `onWaiting` once a new version waits: `atLoad` when it already waited
 * as the page loaded, false when it finished installing while the page was
 * open. Only an update waits: the very first install takes over at once.
 * Returns the cleanup.
 */
export function watchForUpdate(onWaiting: (worker: ServiceWorker, atLoad: boolean) => void): () => void {
  const container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  if (!container) return () => {};
  let stopped = false;
  let registration: ServiceWorkerRegistration | null = null;
  let lastCheck = Date.now();
  const report = (worker: ServiceWorker | null, atLoad = false) => {
    if (worker && !stopped && container.controller) onWaiting(worker, atLoad);
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
    const atLoad = firstCheck;
    firstCheck = false;
    if (ready.waiting) report(ready.waiting, atLoad);
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

/**
 * Lets the waiting version take over; resolves once it controls the page, at
 * once when it already took over (another tab's « Recharger »), or after `timeoutMs`.
 */
export function activate(worker: ServiceWorker, timeoutMs: number): Promise<void> {
  if (worker.state === 'activated' || worker.state === 'activating') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    navigator.serviceWorker.addEventListener('controllerchange', done);
    worker.postMessage(SKIP_WAITING);
  });
}

/** The version waiting or still installing after a fresh check, if any. */
export async function pendingWorker(registration: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
  await registration.update().catch(() => {});
  if (registration.waiting) return registration.waiting;
  return registration.installing ? installed(registration.installing) : null;
}
