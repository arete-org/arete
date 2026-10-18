import {
  restoreConversation,
  STORAGE_KEY as LEGACY_KEY,
} from './agentConversation';
import { isContextWindowUsage, type ChatMessage, type ContextWindowUsage } from './agentStream';
import { isCoachReference, type CoachReference } from './coachToday';

export const THREADS_KEY = 'arete.coach.threads.v1';
export const MAX_THREADS = 100;
const MAX_STORAGE_CHARS = 4_000_000;
const TITLE_CHARS = 64;
export const NEW_THREAD_TITLE = 'Nouvelle conversation';

export interface CoachThread {
  titleManual?: boolean;
  archiveRevision?: number;
  archiveDigest?: string;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  draft: string;
  attachmentIds?: string[];
  contextWindowUsage?: ContextWindowUsage;
  reference?: CoachReference;
}
export interface ThreadStore {
  version: 1;
  activeId: string;
  threads: CoachThread[];
}
export interface LoadedThreads {
  store: ThreadStore;
  error: string | null;
}

export function createThread(): CoachThread {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: NEW_THREAD_TITLE,
    createdAt: now,
    updatedAt: now,
    messages: [],
    draft: '',
  };
}
export function emptyStore(): ThreadStore {
  const thread = createThread();
  return { version: 1, activeId: thread.id, threads: [thread] };
}
export function titleFromMessage(content: string): string {
  const title = content.replace(/\s+/g, ' ').trim();
  // Only the display title is abbreviated; the full message remains intact.
  return title.length > TITLE_CHARS
    ? `${title.slice(0, TITLE_CHARS)}…`
    : title || NEW_THREAD_TITLE;
}
export function updateThread(
  store: ThreadStore,
  id: string,
  update: (thread: CoachThread) => CoachThread
): ThreadStore {
  return {
    ...store,
    threads: store.threads.map((thread) =>
      thread.id === id ? update(thread) : thread
    ),
  };
}
export function addThread(
  store: ThreadStore,
  thread = createThread()
): ThreadStore {
  const empty = store.threads.find(
    (t) => !t.reference && !t.messages.length && !t.draft.trim() && !t.attachmentIds?.length
  );
  // A briefing owns a fresh identity; replacing a truly blank placeholder loses no work.
  if (empty && thread.reference) return { ...store, activeId: thread.id, threads: store.threads.map(t => t.id === empty.id ? thread : t) };
  if (empty) return { ...store, activeId: empty.id };
  if (store.threads.length >= MAX_THREADS)
    throw new Error(
      `Limite de ${MAX_THREADS} fils locaux atteinte. Attends leur sauvegarde avant de créer un autre fil.`
    );
  return { ...store, activeId: thread.id, threads: [thread, ...store.threads] };
}
export function removeThread(store: ThreadStore, id: string): ThreadStore {
  const threads = store.threads.filter((t) => t.id !== id);
  if (!threads.length) return emptyStore();
  const activeId =
    store.activeId === id
      ? [...threads].sort((a, b) => b.updatedAt - a.updatedAt)[0].id
      : store.activeId;
  return { ...store, threads, activeId };
}

/** A versioned, local-only store: preserve all legacy messages on migration. */
export function restoreThreads(
  raw: string | null,
  legacyRaw: string | null
): ThreadStore {
  if (!raw) {
    const store = emptyStore();
    const messages = restoreConversation(legacyRaw);
    if (messages.length) {
      store.threads[0].messages = messages;
      store.threads[0].title = titleFromMessage(
        messages.find((m) => m.role === 'user')?.content ??
          'Conversation précédente'
      );
    }
    return store;
  }
  if (raw.length > MAX_STORAGE_CHARS)
    throw new Error('Historique des conversations trop volumineux.');
  const data = JSON.parse(raw);
  if (
    !data ||
    data.version !== 1 ||
    !Array.isArray(data.threads) ||
    !data.threads.length ||
    data.threads.length > MAX_THREADS
  )
    throw new Error('Historique des conversations invalide.');
  const ids = new Set<string>();
  const threads: CoachThread[] = data.threads.map((t: CoachThread) => {
    if (
      !t ||
      typeof t.id !== 'string' ||
      !t.id ||
      ids.has(t.id) ||
      typeof t.title !== 'string' ||
      typeof t.draft !== 'string' ||
      !Number.isFinite(t.createdAt) ||
      !Number.isFinite(t.updatedAt) ||
      !Array.isArray(t.messages)
    )
      throw new Error('Conversation sauvegardée invalide.');
    ids.add(t.id);
    if (t.reference !== undefined && !isCoachReference(t.reference))
      throw new Error('Contexte de conversation sauvegardé invalide.');
    return {
      titleManual: t.titleManual === true,
      archiveRevision: Number.isSafeInteger(t.archiveRevision) ? t.archiveRevision : undefined,
      archiveDigest: typeof t.archiveDigest === "string" ? t.archiveDigest : undefined,
      id: t.id,
      title: t.title,
      draft: t.draft,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      attachmentIds: Array.isArray(t.attachmentIds) && t.attachmentIds.length <= 20 && t.attachmentIds.every(id => typeof id === 'string') ? t.attachmentIds : [],
      messages: restoreConversation(JSON.stringify(t.messages)),
      contextWindowUsage: isContextWindowUsage(t.contextWindowUsage) ? t.contextWindowUsage : undefined,
      reference: t.reference,
    };
  });
  if (!ids.has(data.activeId))
    throw new Error('Conversation active introuvable.');
  return { version: 1, activeId: data.activeId, threads };
}
function storageKey(athleteId: number): string {
  if (!Number.isSafeInteger(athleteId) || athleteId < 1) throw new Error('Athlète absent.');
  return athleteId === 1 ? THREADS_KEY : `${THREADS_KEY}.athlete.${athleteId}`;
}

/** Drops the athlete's conversations kept in this browser (its account was erased). */
export function forgetThreads(athleteId: number): void {
  localStorage.removeItem(storageKey(athleteId));
  if (athleteId === 1) localStorage.removeItem(LEGACY_KEY);
  const conflicts = `arete.coach.conflict.${athleteId}.`;
  for (const key of Object.keys(localStorage)) if (key.startsWith(conflicts)) localStorage.removeItem(key);
}

export function loadThreads(athleteId = 1): LoadedThreads {
  try {
    return {
      store: restoreThreads(
        localStorage.getItem(storageKey(athleteId)),
        athleteId === 1 ? localStorage.getItem(LEGACY_KEY) : null
      ),
      error: null,
    };
  } catch (error) {
    console.warn('Chargement des conversations impossible.', error);
    return {
      store: emptyStore(),
      error:
        'Impossible de charger les conversations. La sauvegarde existante est préservée ; ce fil reste temporaire.',
    };
  }
}
export function saveThreads(store: ThreadStore, athleteId = 1): string | null {
  try {
    const raw = JSON.stringify(store);
    if (raw.length > MAX_STORAGE_CHARS)
      throw new Error('Historique trop volumineux pour la sauvegarde locale.');
    localStorage.setItem(storageKey(athleteId), raw);
    // Retire the legacy copy only after the new store was successfully written.
    if (athleteId === 1) localStorage.removeItem(LEGACY_KEY);
    return null;
  } catch (error) {
    console.warn('Sauvegarde des conversations impossible.', error);
    return 'Sauvegarde indisponible. Les dernières modifications restent dans cet onglet ; libère de l’espace ou supprime un ancien fil.';
  }
}
