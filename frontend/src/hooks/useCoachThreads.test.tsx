// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { qk } from '@/lib/queryKeys';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage, StreamEvent } from '@/lib/agentStream';
import { THREADS_KEY, MAX_THREADS } from '@/lib/agentThreads';
import { useCoachThreads } from './useCoachThreads';

const runs = vi.hoisted(
  () =>
    [] as {
      history: ChatMessage[];
      context: { page: string; path: string; params: Record<string, string> };
      threadId: string;
      documentIds?: string[];
      emit: (e: StreamEvent) => void;
      resolve: () => void;
      reject: (e: Error) => void;
      signal: AbortSignal;
      stamp: (sentAt: string) => void;
    }[]
);
vi.mock('@/lib/agentStream', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agentStream')>()),
  runAgentStream: vi.fn(
    (history, _context, emit, signal, threadId, documentIds, _onAccepted, stamp) =>
      new Promise<void>((resolve, reject) => {
        runs.push({ history, context: _context, emit, resolve, reject, signal, threadId, documentIds, stamp });
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Stopped', 'AbortError')),
          { once: true }
        );
      })
  ),
}));
vi.mock('@/lib/conversations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/conversations')>()),
  conversationsApi: { remove: vi.fn().mockResolvedValue({ deleted: true }), save: vi.fn(async t => ({ revision: (t.archiveRevision ?? 0) + 1, title: t.title })), list: vi.fn().mockResolvedValue({ items: [], next_offset: null }), read: vi.fn() },
}));
vi.mock('@/lib/documents', () => ({ documentsApi: { deleteThread: vi.fn().mockResolvedValue({ deleted: true }) } }));
const context = { page: 'dashboard', path: '/', params: {} };
let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  localStorage.clear();
  runs.length = 0;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

it('keeps the server timestamp with its originating human message across turns and reloads', async () => {
  const { result, unmount } = renderHook(() => useCoachThreads(context), { wrapper });
  const first = '2026-10-15T23:59:59+02:00';
  act(() => { result.current.send('Demain ?'); });
  const origin = result.current.active.id;
  act(() => {
    result.current.create();
    runs[0].stamp(first);
    runs[0].stamp('2026-10-16T00:00:01+02:00');
  });
  expect(result.current.active.messages).toHaveLength(0);
  await act(async () => {
    runs[0].emit({ type: 'done', message: { role: 'assistant', content: 'Réponse' } });
    runs[0].resolve();
  });
  act(() => result.current.select(origin));
  expect(result.current.active.messages[0].sentAt).toBe(first);
  unmount();
  const restored = renderHook(() => useCoachThreads(context), { wrapper });
  expect(restored.result.current.active.messages[0].sentAt).toBe(first);
  act(() => { restored.result.current.send('Et aujourd’hui ?'); });
  expect(runs[1].history[0].sentAt).toBe(first);
  expect(runs[1].history.at(-1)?.sentAt).toBeUndefined();
  await act(async () => { runs[1].reject(new Error('Interrompu')); });
});

it.each(['complete', 'error', 'abort'])('keeps counters in the originating thread and clears compaction on %s', async ending => {
  const { result } = renderHook(() => useCoachThreads(context), { wrapper });
  const origin = result.current.active.id;
  act(() => { result.current.send('Question'); });
  const usage = { used_tokens: 900, window_tokens: 1000 };
  act(() => {
    runs[0].emit({ type: 'values', context_window_usage: usage });
    runs[0].emit({ type: 'context_compaction', phase: 'start' });
  });
  expect(result.current.compacting).toBe(true);
  act(() => result.current.create());
  expect(result.current.compacting).toBe(false);
  expect(result.current.active.contextWindowUsage).toBeUndefined();
  act(() => result.current.select(origin));
  expect(result.current.compacting).toBe(true);
  expect(result.current.active.contextWindowUsage).toEqual(usage);
  await act(async () => {
    if (ending === 'abort') result.current.stop();
    else if (ending === 'error') runs[0].reject(new Error('Connexion interrompue'));
    else runs[0].resolve();
  });
  expect(result.current.compacting).toBe(false);
  expect(result.current.active.contextWindowUsage).toEqual(usage);
  expect(runs[0].history).toEqual([{ role: 'user', content: 'Question', attachmentIds: undefined }]);
});

it('keeps late feedback updates on their original turn after switching or deleting threads', async () => {
  const { result } = renderHook(() => useCoachThreads(context), { wrapper });
  const origin = result.current.active.id;
  const trace = { trace_id: '12345678-1234-4123-8123-123456789012', feedback_token: 'a'.repeat(64) };
  act(() => { result.current.send('Question'); });
  await act(async () => {
    runs[0].emit({ type: 'done', message: { role: 'assistant', content: 'Réponse' }, trace });
    runs[0].resolve();
  });
  act(() => { result.current.create(); });
  const target = result.current.active.id;
  const feedback = { user_score: 1 as const, reaction: '🎯', status: 'saved' as const };
  act(() => result.current.feedback(origin, trace.trace_id, feedback));
  expect(result.current.active.id).toBe(target);
  expect(result.current.active.messages).toHaveLength(0);
  expect(result.current.store.threads.find(t => t.id === origin)?.messages[1].feedback).toEqual(feedback);
  await act(async () => result.current.remove(origin));
  act(() => result.current.feedback(origin, trace.trace_id, feedback));
  expect(result.current.active.id).toBe(target);
  expect(result.current.active.messages).toHaveLength(0);
});

it('keeps background results in their originating thread and sends only the selected history', async () => {
  const { result } = renderHook(() => useCoachThreads(context), { wrapper });
  const first = result.current.active.id;
  act(() => {
    result.current.send('Question A');
  });
  act(() => {
    result.current.create();
  });
  const second = result.current.active.id;
  expect(second).not.toBe(first);
  act(() => {
    result.current.draft('Question B');
  });
  act(() => {
    result.current.send();
  });
  expect(runs[0].threadId).toBe(first);
  expect(runs).toHaveLength(1); // Bound remains one run even after switching.
  await act(async () => {
    runs[0].emit({ type: 'token', id: 'm1', text: 'Réponse A' });
    runs[0].emit({
      type: 'done',
      message: { role: 'assistant', content: 'Réponse A' },
    });
    runs[0].resolve();
  });
  expect(result.current.active.messages).toEqual([]);
  expect(result.current.active.draft).toBe('Question B');
  expect(
    result.current.store.threads.find((t) => t.id === first)?.messages[1]
      .content
  ).toBe('Réponse A');
  act(() => {
    result.current.send();
  });
  expect(runs[1].threadId).toBe(second);
  expect(runs[1].history).toEqual([{ role: 'user', content: 'Question B' }]);
  await act(async () => {
    runs[1].resolve();
  });
  act(() => {
    result.current.select(first);
  });
  expect(result.current.active.messages[1].content).toBe('Réponse A');
});

it('aborts deletion of an active run without leaking into the replacement thread', async () => {
  const { result } = renderHook(() => useCoachThreads(context), { wrapper });
  const first = result.current.active.id;
  act(() => {
    result.current.send('Question');
  });
  await act(async () => {
    await result.current.remove(first);
  });
  expect(runs[0].signal.aborted).toBe(true);
  expect(result.current.runningId).toBeNull();
  expect(result.current.active.id).not.toBe(first);
  act(() => {
    runs[0].emit({ type: 'token', id: 'late', text: 'Trop tard' });
  });
  expect(result.current.active.messages).toEqual([]);
});

it('flushes threads and drafts on page exit and restores the active one', () => {
  const { result, unmount } = renderHook(() => useCoachThreads(context), {
    wrapper,
  });
  act(() => {
    result.current.draft('Draft A');
  });
  act(() => {
    result.current.create();
  });
  act(() => {
    result.current.draft('Draft B');
  });
  const activeId = result.current.active.id;
  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
  expect(JSON.parse(localStorage.getItem(THREADS_KEY)!).threads).toHaveLength(
    2
  );
  unmount();
  const restored = renderHook(() => useCoachThreads(context), { wrapper });
  expect(restored.result.current.active.id).toBe(activeId);
  expect(restored.result.current.active.draft).toBe('Draft B');
});

it('preserves corrupt storage instead of overwriting it with an empty thread', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  localStorage.setItem(THREADS_KEY, '{broken');
  const { result, unmount } = renderHook(() => useCoachThreads(context), {
    wrapper,
  });
  expect(result.current.storageError).toContain('préservée');
  act(() => {
    result.current.draft('New draft');
  });
  unmount();
  expect(localStorage.getItem(THREADS_KEY)).toBe('{broken');
});

it('retires the legacy copy only after a successful migration save', () => {
  const legacyKey = 'arete.coach.conversation';
  localStorage.setItem(
    legacyKey,
    JSON.stringify([{ role: 'user', content: 'Ancien fil' }])
  );
  const { result } = renderHook(() => useCoachThreads(context), { wrapper });
  expect(result.current.active.messages[0].content).toBe('Ancien fil');
  expect(localStorage.getItem(legacyKey)).not.toBeNull();
  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
  expect(localStorage.getItem(legacyKey)).toBeNull();
  expect(
    JSON.parse(localStorage.getItem(THREADS_KEY)!).threads[0].messages[0]
      .content
  ).toBe('Ancien fil');
});

it('retains legacy history when saving fails', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const legacyKey = 'arete.coach.conversation';
  const legacy = JSON.stringify([{ role: 'user', content: 'Ancien fil' }]);
  localStorage.setItem(legacyKey, legacy);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota', 'QuotaExceededError');
  });
  renderHook(() => useCoachThreads(context), { wrapper });
  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
  expect(localStorage.getItem(legacyKey)).toBe(legacy);
  expect(localStorage.getItem(THREADS_KEY)).toBeNull();
});

it('reuses the persisted thread ID across turns and reloads', async () => {
  const { result, unmount } = renderHook(() => useCoachThreads(context), {
    wrapper,
  });
  const id = result.current.active.id;
  act(() => {
    result.current.send('Bonjour');
  });
  await act(async () => {
    runs[0].emit({
      type: 'done',
      message: { role: 'assistant', content: 'Bonjour' },
    });
    runs[0].resolve();
  });
  unmount();
  const restored = renderHook(() => useCoachThreads(context), { wrapper });
  act(() => {
    restored.result.current.send('Et demain ?');
  });
  expect(runs.map((run) => run.threadId)).toEqual([id, id]);
  await act(async () => {
    runs[1].resolve();
  });
});

it('refreshes session caches after a successful tool write even in a background thread', async () => {
  for (const key of [qk.planned(), qk.actual(), qk.workload])
    queryClient.setQueryData(key, []);
  const { result } = renderHook(() => useCoachThreads(context), { wrapper });
  act(() => {
    result.current.send('Prévois une séance');
  });
  act(() => {
    result.current.create();
  });
  const event: StreamEvent = {
    type: 'tool_end',
    id: 'write',
    name: 'create_planned_session',
    status: 'error',
    output: { text: '{}', truncated: false },
    elapsed_ms: 5,
  };
  act(() => {
    runs[0].emit(event);
  });
  expect(queryClient.getQueryState(qk.planned())?.isInvalidated).toBe(false);
  act(() => {
    runs[0].emit({ ...event, name: 'list_planned', status: 'done'
  }); });
  expect(queryClient.getQueryState(qk.planned())?.isInvalidated).toBe(false);
  act(() => {
    runs[0].emit({ ...event, status: 'done'
  }); });
  for (const key of [qk.planned(), qk.actual(), qk.workload])
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  await act(async () => {
    runs[0].reject(new Error('Final answer failed'));
  });
  expect(result.current.active.messages).toEqual([]);
});

it('refetches the visible planning window as soon as a session is created', async () => {
  const session = { id: 2, date: '2026-10-09', target_duration_min: 40 };
  const fetchPlanning = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValue([session]);
  const { result } = renderHook(
    () => ({
      coach: useCoachThreads(context),
      planning: useQuery({
        queryKey: qk.planned('2026-10-05', '2026-10-11'),
        queryFn: fetchPlanning,
        staleTime: Infinity,
      }),
    }),
    { wrapper }
  );
  await waitFor(() => expect(result.current.planning.data).toEqual([]));
  act(() => {
    result.current.coach.send('Prévois une séance demain');
  });
  act(() => {
    runs[0].emit({
      type: 'tool_end',
      id: 'created',
      name: 'create_planned_session',
      status: 'done',
      output: { text: '{}', truncated: false },
      elapsed_ms: 5,
    });
  });
  await waitFor(() => expect(result.current.planning.data).toEqual([session]));
  expect(fetchPlanning).toHaveBeenCalledTimes(2);
  await act(async () => {
    runs[0].resolve();
  });
});


it('snapshots selected documents per message and preserves them for retry across thread changes', async () => {
  const { result } = renderHook(() => useCoachThreads(context, true), { wrapper });
  const first = result.current.active.id;
  act(() => result.current.attachments(['document-a']));
  act(() => { result.current.send('Programme A'); });
  expect(runs[0].documentIds).toEqual(['document-a']);
  expect(result.current.active.attachmentIds).toEqual([]);
  expect(result.current.active.messages[0].attachmentIds).toEqual(['document-a']);
  act(() => result.current.create());
  act(() => result.current.attachments(['document-b']));
  await act(async () => { runs[0].reject(new Error('Réseau indisponible')); });
  expect(result.current.active.attachmentIds).toEqual(['document-b']);
  act(() => result.current.select(first));
  act(() => { result.current.retry(); });
  expect(runs[1].documentIds).toEqual(['document-a']);
  await act(async () => { runs[1].resolve(); });
});

it('refuses an over-limit document request before clearing the draft', () => {
  const { result } = renderHook(() => useCoachThreads(context, true), { wrapper });
  act(() => result.current.attachments(Array.from({ length: 21 }, (_, i) => `doc-${i}`)));
  act(() => result.current.draft('À conserver'));
  act(() => { expect(result.current.send()).toBe(false); });
  expect(runs).toHaveLength(0);
  expect(result.current.active.draft).toBe('À conserver');
  expect(result.current.error).toContain('20 documents');
});

it('keeps attachments after their message leaves the request window and after reload', async () => {
  const first = renderHook(() => useCoachThreads(context, true), { wrapper });
  act(() => first.result.current.attachments(['old-document']));
  for (let turn = 0; turn < 17; turn++) {
    act(() => { first.result.current.send(`Question ${turn}`); });
    await act(async () => {
      runs[turn].emit({ type: 'done', message: { role: 'assistant', content: 'Réponse' } });
      runs[turn].resolve();
    });
  }
  expect(runs[16].history.some(m => m.attachmentIds?.includes('old-document'))).toBe(false);
  expect(runs[16].documentIds).toEqual(['old-document']);
  first.unmount();
  const restored = renderHook(() => useCoachThreads(context, true), { wrapper });
  act(() => { restored.result.current.send('Continue avec le fichier'); });
  expect(runs[17].documentIds).toEqual(['old-document']);
  await act(async () => { runs[17].resolve(); });
});

it.each(['interrupted', 'done'] as const)('never replays a whole tool run after %s and retains the next draft', async status => {
  const { result } = renderHook(() => useCoachThreads(context, true), { wrapper });
  act(() => { result.current.send('Modifie mes notes'); });
  act(() => runs[0].emit({ type: 'tool_start', id: 'edit', name: 'edit_file', args: { text: '{}', truncated: false } }));
  act(() => { result.current.draft('Mon prochain message'); result.current.attachments(['next-document']); });
  await act(async () => {
    if (status === 'interrupted') result.current.stop();
    else {
      runs[0].emit({ type: 'tool_end', id: 'edit', name: 'edit_file', status: 'done', output: { text: '{}', truncated: false }, elapsed_ms: 100 });
      runs[0].emit({ type: 'done', message: { role: 'assistant', content: 'Notes mises à jour.' } });
      runs[0].resolve();
    }
  });
  act(() => { expect(result.current.retry()).toBe(false); });
  expect(runs).toHaveLength(1);
  expect(result.current.active.draft).toBe('Mon prochain message');
  expect(result.current.active.attachmentIds).toEqual(['next-document']);
  expect(result.current.active.messages).toHaveLength(2);
});

it('refreshes the athlete facts after the coach remembers one', async () => {
  queryClient.setQueryData(qk.athleteFacts, []);
  queryClient.setQueryData(qk.planned(), []);
  const { result } = renderHook(() => useCoachThreads(context), { wrapper });
  act(() => {
    result.current.send('J’ai mal au tendon d’Achille');
  });
  act(() => {
    runs[0].emit({
      type: 'tool_end',
      id: 'fact',
      name: 'remember_fact',
      status: 'done',
      output: { text: '{}', truncated: false },
      elapsed_ms: 5,
    });
  });
  expect(queryClient.getQueryState(qk.athleteFacts)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(qk.planned())?.isInvalidated).toBe(false);
  await act(async () => {
    runs[0].resolve();
  });
});


it('opens each briefing in a fresh thread, keeps drafts and binds context only to that thread', async () => {
  const { result, rerender } = renderHook(({ page }) => useCoachThreads(page, true), { wrapper, initialProps: { page: context } });
  const original = result.current.active.id;
  act(() => { result.current.draft('My manual draft'); result.current.attachments(['document-a']); });
  act(() => window.dispatchEvent(new CustomEvent('arete:coach-discuss', { detail: { kind: 'briefing', id: 41 } })));
  const briefing = result.current.active.id;
  expect(briefing).not.toBe(original);
  expect(result.current.active).toMatchObject({ draft: '', messages: [], reference: { kind: 'briefing', id: 41 } });
  expect(result.current.store.threads.find(t => t.id === original)).toMatchObject({ draft: 'My manual draft', attachmentIds: ['document-a'] });
  expect(runs).toHaveLength(0);
  rerender({ page: { page: 'planning', path: '/planning', params: {} } });
  act(() => result.current.send('Pourquoi du repos ?'));
  expect(runs[0].context.page).toBe('planning');
  expect(runs[0].context.params).toEqual({ coach_ref: 'briefing:41' });
  act(() => {
    runs[0].emit({ type: 'token', id: 'a', text: 'Rest ' });
    window.dispatchEvent(new CustomEvent('arete:coach-discuss', { detail: { kind: 'briefing', id: 42 } }));
  });
  expect(result.current.active.id).not.toBe(briefing);
  expect(result.current.active.reference?.id).toBe(42);
  expect(runs[0].signal.aborted).toBe(false);
  await act(async () => { runs[0].emit({ type: 'token', id: 'a', text: 'today.' }); runs[0].resolve(); });
  expect(result.current.active.messages).toEqual([]);
  expect(result.current.store.threads.find(t => t.id === briefing)?.messages[1].content).toBe('Rest today.');
  act(() => result.current.select(original));
  act(() => result.current.send());
  expect(runs[1].context.params).toEqual({});
  await act(async () => runs[1].resolve());
});

it('reports a full thread store without overwriting a draft or starting a request', () => {
  const threads = Array.from({ length: MAX_THREADS }, (_, i) => ({ id: `thread-${i}`, title: 'Keep', createdAt: i, updatedAt: i, messages: [], draft: `draft-${i}` }));
  localStorage.setItem(THREADS_KEY, JSON.stringify({ version: 1, activeId: threads[0].id, threads }));
  const { result } = renderHook(() => useCoachThreads(context), { wrapper });
  act(() => window.dispatchEvent(new CustomEvent('arete:coach-discuss', { detail: { kind: 'briefing', id: 41 } })));
  expect(result.current.error).toContain(`Limite de ${MAX_THREADS}`);
  expect(result.current.active.draft).toBe('draft-0');
  expect(result.current.active.reference).toBeUndefined();
  expect(result.current.store.threads).toHaveLength(MAX_THREADS);
  expect(runs).toHaveLength(0);
});

it('routes a late title to its original thread and preserves a manual rename', async () => {
  const { result } = renderHook(() => useCoachThreads(context), { wrapper });
  act(() => { result.current.send('Hyrox après footing'); });
  const origin = result.current.active.id;
  act(() => result.current.create());
  act(() => runs[0].emit({ type: 'thread_title', thread_id: origin, title: 'Footing et Hyrox' }));
  expect(result.current.active.title).toBe('Nouvelle conversation');
  expect(result.current.store.threads.find(t => t.id === origin)?.title).toBe('Footing et Hyrox');
  act(() => result.current.renameLocal(origin, 'Mon entraînement'));
  act(() => runs[0].emit({ type: 'thread_title', thread_id: origin, title: 'Titre retardé' }));
  expect(result.current.store.threads.find(t => t.id === origin)?.title).toBe('Mon entraînement');
  await act(async () => runs[0].resolve());
});

it('opens a thirty-first thread without discarding any older draft', () => {
  const threads = Array.from({ length: 30 }, (_, i) => ({ id: `thread-${i}`, title: 'Keep', createdAt: i, updatedAt: i, messages: [], draft: `draft-${i}` }));
  localStorage.setItem(THREADS_KEY, JSON.stringify({ version: 1, activeId: threads[0].id, threads }));
  const { result } = renderHook(() => useCoachThreads(context), { wrapper });
  act(() => result.current.create());
  expect(result.current.store.threads).toHaveLength(31);
  expect(result.current.store.threads.filter(t => t.draft)).toHaveLength(30);
  expect(result.current.error).toBe('');
});

it('answers an evening question once, without a model request, then chats as usual', async () => {
  const { coachApi } = await import('@/lib/coachToday');
  const message = { id: 7, date: '2026-10-16', for_date: '2026-10-17', reasons: ['session'], text: 'Tempo demain. Comment sont tes jambes ?', question: 'Comment sont tes jambes ?', written_at: null, answered_at: null, answerable: true, journaled: false };
  const answer = vi.spyOn(coachApi, 'answerEvening').mockResolvedValue({ ...message, answer: 'Lourdes.', answered_at: '2026-10-16T18:40:00+00:00', answerable: false, journaled: true, journal: 'written' });
  const { result } = renderHook(() => useCoachThreads(context), { wrapper });
  act(() => result.current.draft('Brouillon gardé'));
  act(() => window.dispatchEvent(new CustomEvent('arete:coach-discuss', { detail: { kind: 'evening', id: 7 } })));
  const evening = result.current.active.id;
  expect(result.current.active).toMatchObject({ title: 'Question du soir', reference: { kind: 'evening', id: 7 }, draft: '' });
  act(() => result.current.draft('Lourdes.'));
  await act(async () => { result.current.send(); });
  await waitFor(() => expect(result.current.active.messages).toEqual([{ role: 'user', content: 'Lourdes.' }]));
  expect(answer).toHaveBeenCalledExactlyOnceWith(7, 'Lourdes.', expect.any(AbortSignal));
  expect(runs).toHaveLength(0);
  expect(result.current.active.draft).toBe('');
  // The next message is a normal turn, with the message as context.
  act(() => { result.current.send('Je décale ?'); });
  expect(runs).toHaveLength(1);
  expect(runs[0].context.params).toEqual({ coach_ref: 'evening:7' });
  await act(async () => { runs[0].resolve(); });
  // Opening the push again returns to the same thread.
  act(() => result.current.create());
  act(() => window.dispatchEvent(new CustomEvent('arete:coach-discuss', { detail: { kind: 'evening', id: 7 } })));
  expect(result.current.active.id).toBe(evening);
  expect(answer).toHaveBeenCalledTimes(1);
});

const eveningMessage = { id: 8, date: '2026-10-16', for_date: '2026-10-17', reasons: ['session'], text: 'Tempo demain. Ça va ?', question: 'Ça va ?', written_at: null, answer: null, answered_at: null, answerable: true, journaled: false };

it('keeps the draft and hedges when the evening answer may be lost', async () => {
  const { coachApi } = await import('@/lib/coachToday');
  vi.spyOn(coachApi, 'answerEvening').mockRejectedValue(new TypeError('Failed to fetch'));
  const { result } = renderHook(() => useCoachThreads(context), { wrapper });
  act(() => window.dispatchEvent(new CustomEvent('arete:coach-discuss', { detail: { kind: 'evening', id: 8 } })));
  act(() => result.current.draft('Bien.'));
  await act(async () => { result.current.send(); });
  await waitFor(() => expect(result.current.error).toBe('Réponse peut-être non enregistrée : vérifie ci-dessus.'));
  expect(result.current.active.messages).toEqual([]);
  expect(result.current.active.draft).toBe('Bien.');
  expect(result.current.runningId).toBeNull();
  // The refetch shows the server kept it: resending costs nothing.
  queryClient.setQueryData(['coachEvening', 8], { ...eveningMessage, answer: 'Bien.', answerable: false });
  act(() => { result.current.send(); });
  expect(result.current.active.messages).toEqual([{ role: 'user', content: 'Bien.' }]);
  expect(runs).toHaveLength(0);
});

it('chats normally once the evening question is closed', async () => {
  const { coachApi } = await import('@/lib/coachToday');
  const { ApiError } = await import('@/lib/api');
  const answer = vi.spyOn(coachApi, 'answerEvening').mockRejectedValue(new ApiError(409, '{"detail":"Cette question portait sur une journée passée."}'));
  vi.spyOn(coachApi, 'evening').mockResolvedValue({ ...eveningMessage, answerable: false });
  const { result } = renderHook(() => useCoachThreads(context), { wrapper });
  act(() => window.dispatchEvent(new CustomEvent('arete:coach-discuss', { detail: { kind: 'evening', id: 8 } })));
  act(() => result.current.draft('On en parle ?'));
  await act(async () => { result.current.send(); });
  await waitFor(() => expect(result.current.error).toBe('Cette question est close : renvoie ton message pour en parler dans la conversation.'));
  expect(result.current.active.draft).toBe('On en parle ?');
  act(() => { result.current.send(); });
  expect(runs).toHaveLength(1);
  expect(runs[0].context.params).toEqual({ coach_ref: 'evening:8' });
  expect(answer).toHaveBeenCalledTimes(1);
  await act(async () => { runs[0].resolve(); });
});

it('a question the server already closed goes straight to Chiron', () => {
  queryClient.setQueryData(['coachEvening', 8], { ...eveningMessage, answerable: false });
  const { result } = renderHook(() => useCoachThreads(context), { wrapper });
  act(() => window.dispatchEvent(new CustomEvent('arete:coach-discuss', { detail: { kind: 'evening', id: 8 } })));
  act(() => { result.current.send('Et demain ?'); });
  expect(runs).toHaveLength(1);
});

it('refuses an over-long answer in French before any request', async () => {
  const { coachApi } = await import('@/lib/coachToday');
  const answer = vi.spyOn(coachApi, 'answerEvening');
  const { result } = renderHook(() => useCoachThreads(context), { wrapper });
  act(() => window.dispatchEvent(new CustomEvent('arete:coach-discuss', { detail: { kind: 'evening', id: 8 } })));
  act(() => { result.current.send('a'.repeat(1001)); });
  expect(result.current.error).toBe('Ta réponse dépasse 1 000 caractères : raccourcis-la.');
  expect(answer).not.toHaveBeenCalled();
  expect(runs).toHaveLength(0);
});

it('sends the evening answer without attachments, explicitly', async () => {
  const { coachApi } = await import('@/lib/coachToday');
  const answer = vi.spyOn(coachApi, 'answerEvening');
  const { result } = renderHook(() => useCoachThreads(context, true), { wrapper });
  act(() => window.dispatchEvent(new CustomEvent('arete:coach-discuss', { detail: { kind: 'evening', id: 8 } })));
  act(() => result.current.attachments(['doc-1']));
  act(() => { result.current.send('Bien.'); });
  expect(result.current.error).toBe('La réponse à la question du soir part sans pièce jointe : retire-les ou envoie-les ensuite.');
  expect(answer).not.toHaveBeenCalled();
  expect(runs).toHaveLength(0);
});

it('a passing conflict leaves the evening question open', async () => {
  const { coachApi } = await import('@/lib/coachToday');
  const { ApiError } = await import('@/lib/api');
  const answer = vi.spyOn(coachApi, 'answerEvening').mockRejectedValue(new ApiError(409, '{"detail":"Réponse concurrente : recharge le message."}'));
  vi.spyOn(coachApi, 'evening').mockResolvedValue(eveningMessage);
  const { result } = renderHook(() => useCoachThreads(context), { wrapper });
  act(() => window.dispatchEvent(new CustomEvent('arete:coach-discuss', { detail: { kind: 'evening', id: 8 } })));
  act(() => result.current.draft('Bien.'));
  await act(async () => { result.current.send(); });
  await waitFor(() => expect(result.current.error).toBe('Réponse non enregistrée : réessaie.'));
  await waitFor(() => expect(result.current.runningId).toBeNull());
  await act(async () => { result.current.send(); });
  expect(answer).toHaveBeenCalledTimes(2);
  expect(runs).toHaveLength(0);
});
