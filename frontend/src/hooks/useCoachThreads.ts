import { conversationsApi, archivePayload, digest, hasLocalCharts, restoreLocalCharts } from '@/lib/conversations';
import { useConversationArchive } from './useConversationArchive';
import { useAuthState } from '@/components/auth/authState';
import { markWorkout, measureWorkout } from '@/lib/workoutPerformance';
import { cacheWorkout } from '@/lib/workouts';
import { canRetryMessage } from '@/lib/agentActivity';
import { holdReloads } from '@/lib/chunkReload';
import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MessageFeedback } from '@/lib/agentFeedback';
import { invalidateAfterGarminRefresh, invalidateAfterSession, qk } from '@/lib/queryKeys';
import type { PanelPageContext } from '@/lib/pageContext';
import { coachApi, eveningKey, isCoachReference, type EveningMessage } from '@/lib/coachToday';
import {
  applyEvent,
  MAX_MESSAGE_CHARS,
  requestWindow,
  runAgentStream,
  settleMessage,
  type ChatMessage,
} from '@/lib/agentStream';
import {
  MAX_THREADS,
  addThread,
  createThread,
  loadThreads,
  removeThread,
  saveThreads,
  titleFromMessage,
  updateThread,
  type ThreadStore,
} from '@/lib/agentThreads';

// One model run for the whole coach. Switching threads can never fan out requests.
const MAX_ACTIVE_RUNS = 1;
const SAVE_DELAY_MS = 250;
const SESSION_WRITE_TOOLS = new Set([
  'create_planned_session',
  'export_garmin_sessions',
  'reconcile_garmin_session',
  'sync_garmin_activities',
  'update_planned_session',
  'delete_planned_session',
  'save_workout',
]);
const FACT_WRITE_TOOLS = new Set(['remember_fact', 'forget_fact']);

export function useCoachThreads(context: PanelPageContext, selectedDocuments = false) {
  const queryClient = useQueryClient();
  const { athleteId } = useAuthState();
  if (athleteId === null) throw new Error("Athlète absent.");
  const [initial] = useState(() => loadThreads(athleteId));
  const [store, commitStore] = useState(initial.store);
  const [storageError, setStorageError] = useState(initial.error);
  const [error, setError] = useState('');
  const [runningId, setRunningId] = useState<string | null>(null);
  const [compactingId, setCompactingId] = useState<string | null>(null);
  const runRef = useRef<{
    threadId: string;
    controller: AbortController;
  } | null>(null);
  const storeRef = useRef(store);
  const openSequence = useRef(0);
  // Native discussion events and SSE chunks can share a React batch. Apply all
  // updates to the latest store synchronously so opening a thread loses neither.
  const setStore = useCallback((update: SetStateAction<ThreadStore>) => {
    const next = typeof update === 'function' ? update(storeRef.current) : update;
    storeRef.current = next;
    commitStore(next);
  }, []);
  const archive = useConversationArchive(store, setStore, !initial.error);
  const active = store.threads.find((t) => t.id === store.activeId);
  if (!active)
    throw new Error('Invariant violated: active coach thread missing.');

  useEffect(() => {
    const discuss = (event: Event) => {
      openSequence.current += 1;
      const reference: unknown = (event as CustomEvent).detail;
      if (!isCoachReference(reference)) return;
      try {
        const current = storeRef.current;
        // One thread per evening message: opening its push again returns to it.
        const evening = reference.kind === 'evening'
          ? current.threads.find(t => t.reference?.kind === 'evening' && t.reference.id === reference.id)
          : undefined;
        const titles = { briefing: 'Briefing avec Chiron', onboarding: 'Mon point de départ', evening: 'Question du soir' } as const;
        const next = evening ? { ...current, activeId: evening.id }
          : reference.kind === 'briefing' || reference.kind === 'onboarding' || reference.kind === 'evening'
          ? addThread(current, { ...createThread(), title: titles[reference.kind], reference })
          : updateThread(current, current.activeId, thread => ({ ...thread, reference }));
        setStore(next);
        setError('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Impossible d’ouvrir la discussion.');
      }
    };
    window.addEventListener('arete:coach-discuss', discuss);
    return () => window.removeEventListener('arete:coach-discuss', discuss);
  }, [setStore]);

  // Debounce writes while streaming and flush on page exit. Keep corrupt source
  // storage untouched if loading failed, and make quota errors visible in the UI.
  useEffect(() => {
    if (initial.error) return;
    const timeout = window.setTimeout(
      () => setStorageError(saveThreads(storeRef.current, athleteId)),
      SAVE_DELAY_MS
    );
    return () => window.clearTimeout(timeout);
  }, [store, initial.error, athleteId]);
  useEffect(() => {
    const persist = () => {
      if (!initial.error) saveThreads(storeRef.current, athleteId);
    };
    window.addEventListener('pagehide', persist);
    return () => {
      window.removeEventListener('pagehide', persist);
      persist();
      runRef.current?.controller.abort();
    };
  }, [initial.error, athleteId]);

  useEffect(() => {
    holdReloads(runningId !== null);
  }, [runningId]);

  const select = (id: string) => {
    openSequence.current += 1;
    setStore((prev) =>
      prev.threads.some((t) => t.id === id) ? { ...prev, activeId: id } : prev
    );
    setError('');
  };
  const openArchived = useCallback(async (id: string) => {
    const sequence = ++openSequence.current;
    const local = storeRef.current.threads.find(t => t.id === id);
    if (local) setStore(prev => ({ ...prev, activeId: id }));
    try {
      if (local && (!local.archiveDigest || local.messages.some(m => m.pending) || await digest(archivePayload(local)) !== local.archiveDigest)) return;
      const remote = await conversationsApi.read(id);
      if (sequence !== openSequence.current) return;
      const current = storeRef.current.threads.find(t => t.id === id);
      if (current && current !== local) return;
      const thread = { ...restoreLocalCharts(remote, local), draft: local?.draft ?? "", attachmentIds: local?.attachmentIds ?? [] };
      setStore(prev => {
        if (prev.threads.length >= MAX_THREADS && !prev.threads.some(t => t.id === id)) throw new Error("Trop de fils locaux non sauvegardés. Termine leur sauvegarde avant de charger un autre fil.");
        return { ...prev, activeId: id, threads: [thread, ...prev.threads.filter(t => t.id !== id)] };
      });
      setError('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Conversation indisponible.'); }
  }, [setStore]);
  useEffect(() => {
    const open = (event: Event) => { const id = (event as CustomEvent).detail; if (typeof id === 'string') void openArchived(id); };
    const fresh = () => { openSequence.current += 1; try { setStore(prev => addThread(prev)); } catch (err) { setError(String(err)); } };
    const deleted = (event: Event) => { const id = (event as CustomEvent).detail; if (typeof id !== 'string') return; if (runRef.current?.threadId === id) runRef.current.controller.abort(); setStore(prev => removeThread(prev, id)); };
    const renamed = (event: Event) => { const { id, title } = (event as CustomEvent).detail; if (typeof id === 'string' && typeof title === 'string') setStore(prev => updateThread(prev, id, t => ({ ...t, title, titleManual: true }))); };
    window.addEventListener('arete:conversation-deleted', deleted);
    window.addEventListener('arete:conversation-renamed', renamed);
    window.addEventListener('arete:conversation-new', fresh);
    window.addEventListener('arete:conversation-open', open);
    return () => { window.removeEventListener('arete:conversation-open', open); window.removeEventListener('arete:conversation-new', fresh); window.removeEventListener('arete:conversation-deleted', deleted); window.removeEventListener('arete:conversation-renamed', renamed); openSequence.current += 1; };
  }, [openArchived, setStore]);

  useEffect(() => {
    if (store.threads.length < 30) return;
    let cancelled = false;
    void (async () => {
      const removable: string[] = [];
      for (const thread of store.threads) {
        if (thread.id === store.activeId || thread.id === runningId || thread.draft || thread.attachmentIds?.length || !thread.archiveDigest || hasLocalCharts(thread)) continue;
        if (await digest(archivePayload(thread)) === thread.archiveDigest) removable.push(thread.id);
      }
      if (!cancelled && removable.length) setStore(prev => ({ ...prev, threads: prev.threads.filter(t => !removable.includes(t.id) || t !== store.threads.find(old => old.id === t.id)) }));
    })().catch(err => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [store, runningId, setStore]);
  const create = () => {
    openSequence.current += 1;
    try {
      const candidate = createThread();
      setStore((prev) => addThread(prev, candidate));
      setError('');
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Impossible de créer une conversation.'
      );
    }
  };
  const remove = async (id: string) => {
    if (runRef.current?.threadId === id) runRef.current.controller.abort();
    try { await conversationsApi.remove(id); }
    catch (err) { setError(err instanceof Error ? err.message : 'Suppression des documents impossible.'); return; }
    setStore((prev) => removeThread(prev, id));
    setError('');
  };
  const attachments = useCallback((ids: string[]) => {
    setStore(prev => updateThread(prev, active.id, thread => JSON.stringify(thread.attachmentIds ?? []) === JSON.stringify(ids) ? thread : { ...thread, attachmentIds: ids }));
  }, [active.id, setStore]);
  const draft = (text: string) => {
    setStore((prev) =>
      updateThread(prev, prev.activeId, (t) => ({ ...t, draft: text }))
    );
  };
  const stop = useCallback(() => runRef.current?.controller.abort(), []);

  /** The first message of an evening message's thread answers its question:
   *  kept and filed in the journal by the server, with no model request. The
   *  draft stays until the answer is saved. */
  const answerEvening = (id: number, content: string) => {
    const threadId = active.id;
    runRef.current = { threadId, controller: new AbortController() };
    setRunningId(threadId);
    setError('');
    void coachApi.answerEvening(id, content)
      .then(saved => {
        queryClient.setQueryData(eveningKey(id), saved);
        setStore(prev => updateThread(prev, threadId, t => ({
          ...t,
          draft: t.draft.trim() === content ? '' : t.draft,
          updatedAt: Date.now(),
          messages: [...t.messages, { role: 'user', content }],
        })));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? `Réponse non enregistrée : ${err.message}` : 'Réponse non enregistrée.');
        void queryClient.invalidateQueries({ queryKey: eveningKey(id) });
      })
      .finally(() => {
        runRef.current = null;
        setRunningId(null);
      });
    return true;
  };

  /** ``keep`` = messages kept before the new question (a retry drops the
   *  failed or unwanted answer and asks the same question again). */
  const send = (prompt = active.draft, keep = active.messages.length) => {
    const content = prompt.trim();
    const activeRuns = runRef.current ? 1 : 0;
    if (!content || activeRuns >= MAX_ACTIVE_RUNS) return false;
    const evening = active.reference?.kind === 'evening' ? active.reference : null;
    if (evening && keep === 0 && !active.messages.length && !queryClient.getQueryData<EveningMessage>(eveningKey(evening.id))?.answer)
      return answerEvening(evening.id, content);
    const retrying = keep < active.messages.length;
    const attachmentIds = selectedDocuments ? (retrying ? active.messages[keep]?.attachmentIds ?? [] : active.attachmentIds ?? []) : undefined;
    const history = requestWindow([
      ...active.messages.slice(0, keep).map(m => m.workouts?.length ? {
        ...m, error: undefined, interrupted: false,
        content: `${m.content}\nSéances concernées : ${m.workouts.map(w => `#${w.session.id} (${w.session.date}, ${w.session.description}, état observé : ${w.export?.state ?? 'enregistrée'}).`).join(' ')} Relire leur état actuel avant toute écriture.`,
      } : m).filter(
        (m) => m.content.trim() && !m.error && !m.interrupted
      ),
      { role: 'user', content, attachmentIds },
    ]);
    // Files belong to the thread, independently of the model's message window.
    // Keep retry's original selection and exclude the next unsent draft.
    const documentIds = selectedDocuments ? [...new Set([
      ...active.messages.slice(0, keep).flatMap(m => m.attachmentIds ?? []),
      ...attachmentIds ?? [],
    ])] : undefined;
    if (documentIds && documentIds.length > 20) {
      setError('Cette demande référence plus de 20 documents. Ouvre une nouvelle conversation.');
      return false;
    }
    if (history.some((m) => m.content.length > MAX_MESSAGE_CHARS)) {
      setError(
        'Un message dépasse 16 000 caractères. Raccourcis-le ou crée une nouvelle conversation.'
      );
      return false;
    }
    const threadId = active.id;
    const answerIndex = keep + 1;
    const controller = new AbortController();
    const run = { threadId, controller };
    runRef.current = run;
    markWorkout('coach:request-start');
    performance.clearMarks('coach:first-feedback');
    performance.clearMarks('coach:first-text');
    performance.clearMarks('coach:first-workout');
    performance.clearMarks('coach:first-scheduled');
    performance.clearMarks('coach:last-token');
    setRunningId(threadId);
    setCompactingId(null);
    setError('');
    setStore((prev) =>
      updateThread(prev, threadId, (t) => ({
        ...t,
        title: t.messages.length ? t.title : titleFromMessage(content),
        draft: retrying ? t.draft : '',
        attachmentIds: selectedDocuments && !retrying ? [] : t.attachmentIds,
        updatedAt: Date.now(),
        messages: [
          ...t.messages.slice(0, keep),
          { role: 'user', content, attachmentIds },
          { role: 'assistant', content: '', parts: [], pending: true, startedAt: Date.now() },
        ],
      }))
    );
    // Capture the originating thread and answer, never the currently selected
    // thread. Late events after switching or deletion cannot leak into a new thread.
    const patchAnswer = (patch: (message: ChatMessage) => ChatMessage) =>
      setStore((prev) =>
        updateThread(prev, threadId, (t) => {
          const message = t.messages[answerIndex];
          if (!message || message.role !== 'assistant') return t;
          return {
            ...t,
            updatedAt: Date.now(),
            messages: t.messages.map((m, i) =>
              i === answerIndex ? patch(m) : m
            ),
          };
        })
      );
    void runAgentStream(
      history,
      { ...context, params: { ...context.params, ...(active.reference ? { coach_ref: `${active.reference.kind}:${active.reference.id}` } : {}) } },
      (event) => {
        if (controller.signal.aborted) return;
        if (event.type === 'thread_title') {
          if (event.thread_id !== threadId) throw new Error('Titre reçu pour un autre fil.');
          setStore(prev => updateThread(prev, threadId, t => t.titleManual ? t : ({ ...t, title: event.title })));
          return;
        }
        if (event.type === 'values') {
          setStore(prev => updateThread(prev, threadId, thread => ({
            ...thread, contextWindowUsage: event.context_window_usage,
          })));
          return;
        }
        if (event.type === 'context_compaction') {
          setCompactingId(event.phase === 'start' ? threadId : null);
          return;
        }
        if (event.type === 'sync_status' && event.state !== 'running') {
          invalidateAfterGarminRefresh(queryClient, event.state);
        }
        if (event.type === 'workout_update') {
          if (event.thread_id !== threadId) throw new Error('Événement reçu pour un autre fil.');
          cacheWorkout(queryClient, event);
          markWorkout('coach:workout-received');
          if (!performance.getEntriesByName('coach:first-workout', 'mark').length) {
            markWorkout('coach:first-workout');
            measureWorkout('coach:time-to-useful-result', 'coach:request-start', 'coach:first-workout');
          }
          if (['scheduled', 'transfer_requested'].includes(event.export?.state ?? '') && !performance.getEntriesByName('coach:first-scheduled', 'mark').length) {
            markWorkout('coach:first-scheduled');
            measureWorkout('coach:time-to-scheduled', 'coach:request-start', 'coach:first-scheduled');
          }
        }
        if (event.type === 'token') {
          markWorkout('coach:token-received');
          measureWorkout('coach:last-stream-gap', 'coach:last-token', 'coach:token-received');
          markWorkout('coach:last-token');
        }
        if ((event.type === 'token' || event.type === 'message') && event.text.trim() && !performance.getEntriesByName('coach:first-text', 'mark').length) {
          markWorkout('coach:first-text');
          measureWorkout('coach:time-to-first-text', 'coach:request-start', 'coach:first-text');
        }
        if (event.type === 'done') {
          markWorkout('coach:done');
          measureWorkout('coach:total', 'coach:request-start', 'coach:done');

        }
        patchAnswer((m) => applyEvent(m, event));
        // Refresh when the write completes, even if the final answer fails or
        // the athlete has switched threads while this run was in flight.
        if (event.type === 'tool_end' && event.status === 'done') {
          if (SESSION_WRITE_TOOLS.has(event.name)) invalidateAfterSession(queryClient);
          if (['append_journal', 'edit_file', 'delete'].includes(event.name)) {
            void queryClient.invalidateQueries({ queryKey: ['onboarding-context'] });
            void queryClient.invalidateQueries({ queryKey: ['onboarding'] });
          }
          if (FACT_WRITE_TOOLS.has(event.name))
            void queryClient.invalidateQueries({ queryKey: qk.athleteFacts });
        }
      },
      controller.signal,
      threadId,
      documentIds,
      () => { if (!controller.signal.aborted) patchAnswer(m => ({ ...m, streamAccepted: true })); },
      (sentAt) => {
        if (controller.signal.aborted) return;
        setStore(prev => updateThread(prev, threadId, thread => ({
          ...thread,
          messages: thread.messages.map((message, index) =>
            index === keep && message.role === 'user' && message.sentAt === undefined
              ? { ...message, sentAt } : message
          ),
        })));
      },
    )
      .catch((err: unknown) =>
        patchAnswer((m) =>
          settleMessage(
            m,
            controller.signal.aborted
              ? undefined
              : err instanceof Error
                ? err.message
                : 'Erreur inconnue.',
            controller.signal.aborted
          )
        )
      )
      .finally(() => {
        runRef.current = null;
        setRunningId(null);
        setCompactingId(null);
      });
    return true;
  };
  /** Ask the last question again, replacing its answer. */
  const retry = () => {
    const answer = active.messages.at(-1);
    if (answer && !canRetryMessage(answer)) return false;
    const last = active.messages.map((m) => m.role).lastIndexOf('user');
    return last >= 0 && send(active.messages[last].content, last);
  };

  const recordAction = (threadId: string, text: string) => setStore(prev => updateThread(prev, threadId, t => ({
    ...t, updatedAt: Date.now(), messages: [...t.messages, { role: 'assistant', content: text }],
  })));

  return {
    feedback: (threadId: string, traceId: string, feedback: MessageFeedback) => setStore(prev => updateThread(prev, threadId, t => ({
      ...t, messages: t.messages.map(m => m.trace?.trace_id === traceId ? { ...m, feedback } : m),
    }))),
    recordAction,
    renameLocal: (id: string, title: string) => setStore(prev => updateThread(prev, id, t => ({ ...t, title, titleManual: true }))),
    clearReference: () => setStore(prev => updateThread(prev, prev.activeId, thread => ({ ...thread, reference: undefined }))),
    store,
    active,
    runningId,
    compacting: compactingId === active.id,
    error,
    storageError: archive.error || storageError,
    retryArchive: archive.retry,
    recoverArchive: async () => {
      const local = storeRef.current.threads.find(t => t.id === storeRef.current.activeId)!;
      if (runRef.current?.threadId === local.id) { setError('Arrête la réponse avant de recharger ce fil.'); return; }
      try {
        const remote = await conversationsApi.read(local.id);
        if (storeRef.current.threads.find(t => t.id === local.id) !== local) { setError('Le fil a changé pendant la lecture. Réessaie.'); return; }
        // Preserve the complete conflicting snapshot under this athlete before
        // accepting the server version; drafts and selected files stay usable.
        localStorage.setItem(`arete.coach.conflict.${athleteId}.${local.id}`, JSON.stringify(local));
        setStore(prev => updateThread(prev, local.id, () => ({ ...restoreLocalCharts(remote, local), draft: local.draft, attachmentIds: local.attachmentIds })));
        archive.retry();
      } catch (err) { setError(err instanceof Error ? err.message : 'Lecture impossible.'); }
    },
    select,
    openArchived,
    create,
    remove,
    draft,
    attachments,
    send,
    retry,
    stop,
  };
}
