import type { Query, QueryClient } from '@tanstack/react-query';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import { toLocalISODate } from './dates';

/**
 * The query cache a repeat visit paints first, while every query revalidates.
 *
 * One IndexedDB entry per athlete, so another account never restores this one's
 * answers; signing out deletes them all (lib/auth.ts). Only the dashboard's,
 * settings, goals and the sessions of windows containing today are kept: never
 * documents, coach threads, admin data or other weeks.
 */
declare const __APP_BUILD__: string | undefined;

/** Most dashboard data changes once a day. */
export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A new build may change the shape of the answers: it starts from an empty cache. */
export const PERSIST_BUSTER = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : 'dev';
const DATABASE = 'arete-query-cache';
const STORE = 'clients';
const WRITE_DELAY_MS = 1000;
/** Bumped by each wipe: a write scheduled before it never lands after it. */
let generation = 0;
const PERSISTED_ROOTS = [
  'settings', 'game-preference', 'game', 'syncStatus', 'goals', 'planned', 'actual', 'strengthSessions',
  'player-stats', 'fitness', 'workload', 'plan', 'garmin-health', 'tip-daily',
];

export function shouldPersistQuery(query: Query): boolean {
  const [root, start, end] = query.queryKey;
  if (query.state.status !== 'success' || typeof root !== 'string' || !PERSISTED_ROOTS.includes(root)) return false;
  if (root !== 'planned' && root !== 'actual') return true;
  const today = toLocalISODate();
  return typeof start === 'string' && typeof end === 'string' && start <= today && today <= end;
}

/** Queries only: a paused mutation (an offline upload's file, a draft) never reaches IndexedDB. */
export const PERSIST_DEHYDRATE = {
  shouldDehydrateQuery: shouldPersistQuery,
  shouldDehydrateMutation: () => false,
};

/** Kept queries outlive the default 5 minutes of an unused query, or leaving a page would drop them. */
export function keepPersistedQueries(client: QueryClient): void {
  for (const root of PERSISTED_ROOTS) client.setQueryDefaults([root], { gcTime: PERSIST_MAX_AGE_MS });
}

function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    // Absent in some private windows and in older browsers: nothing is kept.
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB indisponible.'));
    const open = indexedDB.open(DATABASE, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction(STORE, mode);
      const result = run(transaction.objectStore(STORE));
      transaction.oncomplete = () => {
        db.close();
        resolve(result.result);
      };
      transaction.onerror = transaction.onabort = () => {
        db.close();
        reject(transaction.error);
      };
    };
  });
}

/** The write waiting for its delay, run at once when the page is hidden or left. */
let flushPending: (() => void) | null = null;
let listening = false;
function flushOnExit(): void {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  const flush = () => flushPending?.();
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

/** Writes at most once a second, always the latest cache; leaving the page writes at once. */
export function athletePersister(athleteId: number): Persister {
  if (!Number.isSafeInteger(athleteId) || athleteId < 1) throw new Error('Athlète absent.');
  const key = `athlete:${athleteId}`;
  let latest: PersistedClient | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  flushOnExit();
  return {
    persistClient: (client) => {
      latest = client;
      if (timer !== undefined) return;
      const scheduled = generation;
      const write = () => {
        clearTimeout(timer);
        timer = undefined;
        if (flushPending === write) flushPending = null;
        const value = latest;
        latest = null;
        if (scheduled !== generation || !value) return;
        request('readwrite', (store) => store.put(value, key)).catch(() => {});
      };
      timer = setTimeout(write, WRITE_DELAY_MS);
      flushPending = write;
    },
    restoreClient: () => request<PersistedClient | undefined>('readonly', (store) => store.get(key)),
    removeClient: () => request('readwrite', (store) => store.delete(key)).then(() => undefined),
  };
}

/** Deletes every athlete's kept answers. */
export async function clearPersistedQueries(): Promise<void> {
  generation++;
  await request('readwrite', (store) => store.clear()).catch(() => {});
}
