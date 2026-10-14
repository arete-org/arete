import { useAuthState } from '@/components/auth/authState';
import { markWorkout, measureWorkout } from '@/lib/workoutPerformance';
import { cacheWorkout } from '@/lib/workouts';
import { canRetryMessage } from '@/lib/agentActivity';
import { holdReloads } from '@/lib/chunkReload';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { documentsApi } from '@/lib/documents';
import type { MessageFeedback } from '@/lib/agentFeedback';
import { invalidateAfterGarminRefresh, invalidateAfterSession, qk } from '@/lib/queryKeys';
import type { PanelPageContext } from '@/lib/pageContext';
import {
  applyEvent,
  MAX_MESSAGE_CHARS,
  requestWindow,
  runAgentStream,
  settleMessage,
  type ChatMessage,
} from '@/lib/agentStream';
import {
  addThread,
  createThread,
  loadThreads,
  removeThread,
  saveThreads,
  titleFromMessage,
  updateThread,
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
  const [store, setStore] = useState(initial.store);
  const [storageError, setStorageError] = useState(initial.error);
  const [error, setError] = useState('');
  const [runningId, setRunningId] = useState<string | null>(null);
  const runRef = useRef<{
    threadId: string;
    controller: AbortController;
  } | null>(null);
  const storeRef = useRef(store);
  const active = store.threads.find((t) => t.id === store.activeId);
  if (!active)
    throw new Error('Invariant violated: active coach thread missing.');

  // Debounce writes while streaming and flush on page exit. Keep corrupt source
  // storage untouched if loading failed, and make quota errors visible in the UI.
  useEffect(() => {
    storeRef.current = store;
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
    setStore((prev) =>
      prev.threads.some((t) => t.id === id) ? { ...prev, activeId: id } : prev
    );
    setError('');
  };
  const create = () => {
    try {
      const candidate = createThread();
      addThread(store, candidate); // Check the bound before queuing the update.
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
    try { await documentsApi.deleteThread(id); }
    catch (err) { setError(err instanceof Error ? err.message : 'Suppression des documents impossible.'); return; }
    setStore((prev) => removeThread(prev, id));
    setError('');
  };
  const attachments = useCallback((ids: string[]) => {
    setStore(prev => updateThread(prev, active.id, thread => JSON.stringify(thread.attachmentIds ?? []) === JSON.stringify(ids) ? thread : { ...thread, attachmentIds: ids }));
  }, [active.id]);
  const draft = (text: string) => {
    setStore((prev) =>
      updateThread(prev, prev.activeId, (t) => ({ ...t, draft: text }))
    );
  };
  const stop = useCallback(() => runRef.current?.controller.abort(), []);

  /** ``keep`` = messages kept before the new question (a retry drops the
   *  failed or unwanted answer and asks the same question again). */
  const send = (prompt = active.draft, keep = active.messages.length) => {
    const content = prompt.trim();
    const activeRuns = runRef.current ? 1 : 0;
    if (!content || activeRuns >= MAX_ACTIVE_RUNS) return false;
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
      context,
      (event) => {
        if (controller.signal.aborted) return;
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
          if (FACT_WRITE_TOOLS.has(event.name))
            void queryClient.invalidateQueries({ queryKey: qk.athleteFacts });
        }
      },
      controller.signal,
      threadId,
      documentIds,
      () => { if (!controller.signal.aborted) patchAnswer(m => ({ ...m, streamAccepted: true })); },
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
    store,
    active,
    runningId,
    error,
    storageError,
    select,
    create,
    remove,
    draft,
    attachments,
    send,
    retry,
    stop,
  };
}
