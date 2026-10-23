// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  addThread,
  emptyStore,
  loadThreads,
  saveThreads,
  MAX_THREADS,
  removeThread,
  restoreThreads,
  updateThread,
} from './agentThreads';

it('restores valid context counters, ignoring corrupt optional telemetry', () => {
  const store = emptyStore();
  const usage = { used_tokens: 1200, window_tokens: 1000 };
  store.threads[0].contextWindowUsage = usage;
  expect(restoreThreads(JSON.stringify(store), null).threads[0].contextWindowUsage).toEqual(usage);
  store.threads[0].contextWindowUsage = { used_tokens: 12, window_tokens: 0 };
  expect(restoreThreads(JSON.stringify(store), null).threads[0].contextWindowUsage).toBeUndefined();
});

it('migrates the existing conversation without dropping text or tool history', () => {
  const legacy = JSON.stringify([
    { role: 'user', content: 'Ma semaine' },
    {
      role: 'assistant',
      content: '**Plan**',
      steps: [{ name: 'read_file', status: 'done' }],
    },
  ]);
  const store = restoreThreads(null, legacy);
  expect(store.threads).toHaveLength(1);
  expect(store.threads[0].title).toBe('Ma semaine');
  expect(store.threads[0].messages[1].parts?.[0]).toMatchObject({
    kind: 'tool',
    status: 'done',
  });
});

it('creates new threads without erasing existing history or drafts', () => {
  let store = emptyStore();
  const first = store.activeId;
  store = updateThread(store, first, (t) => ({
    ...t,
    draft: 'Mon brouillon',
    messages: [{ role: 'user', content: 'Plan course' }],
  }));
  store = addThread(store);
  expect(store.activeId).not.toBe(first);
  expect(store.threads.find((t) => t.id === first)).toMatchObject({
    draft: 'Mon brouillon',
    messages: [{ content: 'Plan course' }],
  });
  // Repeated clicks on New never fill history with empty placeholders.
  expect(addThread(store).threads).toHaveLength(2);
});

it('restores the active thread and interrupted streams after reload', () => {
  let store = emptyStore();
  store = updateThread(store, store.activeId, (t) => ({
    ...t,
    draft: 'Un brouillon',
    messages: [{ role: 'assistant', content: 'Début', pending: true }],
  }));
  const restored = restoreThreads(JSON.stringify(store), null);
  expect(restored.activeId).toBe(store.activeId);
  expect(restored.threads[0].draft).toBe('Un brouillon');
  expect(restored.threads[0].messages[0]).toMatchObject({
    content: 'Début',
    interrupted: true,
    pending: false,
  });
});

it('deletes a thread and always leaves a valid active conversation', () => {
  let store = emptyStore();
  const first = store.activeId;
  store = updateThread(store, first, (t) => ({ ...t, draft: 'Keep me' }));
  store = addThread(store);
  store = removeThread(store, store.activeId);
  expect(store.activeId).toBe(first);
  store = removeThread(store, first);
  expect(store.threads).toHaveLength(1);
  expect(store.threads[0].messages).toEqual([]);
  expect(store.activeId).toBe(store.threads[0].id);
});

it('never redirects a late stream event from a deleted thread into another', () => {
  const before = emptyStore();
  const after = removeThread(before, before.activeId);
  const late = updateThread(after, before.activeId, (t) => ({
    ...t,
    title: 'Late result',
  }));
  expect(late).toEqual(after);
});

describe('storage and capacity bounds', () => {
  it('rejects corrupt state and unknown versions', () => {
    for (const raw of ['{}', '{broken', '{"version":2,"threads":[]}'])
      expect(() => restoreThreads(raw, null)).toThrow();
    const store = emptyStore();
    expect(() =>
      restoreThreads(JSON.stringify({ ...store, activeId: 'missing' }), null)
    ).toThrow();
    expect(() =>
      restoreThreads(
        JSON.stringify({
          ...store,
          threads: [store.threads[0], store.threads[0]],
        }),
        null
      )
    ).toThrow();
  });
  it('fails at the thread limit without silently pruning existing conversations', () => {
    let store = emptyStore();
    for (let i = 1; i < MAX_THREADS; i++) {
      store = updateThread(store, store.activeId, (t) => ({
        ...t,
        draft: `draft ${i}`,
      }));
      store = addThread(store);
    }
    store = updateThread(store, store.activeId, (t) => ({
      ...t,
      draft: 'Final draft',
    }));
    expect(() => addThread(store)).toThrow('Limite');
    expect(store.threads).toHaveLength(MAX_THREADS);
  });
});

it('keeps conversations private when two athletes use the same browser', () => {
  localStorage.clear();
  const first = emptyStore();
  first.threads[0].draft = 'Private first athlete';
  expect(saveThreads(first, 1)).toBeNull();
  expect(loadThreads(2).store.threads[0].draft).toBe('');
  const second = emptyStore();
  second.threads[0].draft = 'Private second athlete';
  expect(saveThreads(second, 2)).toBeNull();
  expect(loadThreads(1).store.threads[0].draft).toBe('Private first athlete');
  expect(loadThreads(2).store.threads[0].draft).toBe('Private second athlete');
});

it('restores thread-owned references and never reuses a contextual thread as a blank one', () => {
  let store = emptyStore();
  store.threads[0].reference = { kind: 'briefing', id: 41 };
  const briefingId = store.activeId;
  store = addThread(store);
  expect(store.activeId).not.toBe(briefingId);
  const restored = restoreThreads(JSON.stringify(store), null);
  expect(restored.threads.find(t => t.id === briefingId)?.reference).toEqual({ kind: 'briefing', id: 41 });
  expect(restored.threads.find(t => t.id === restored.activeId)?.reference).toBeUndefined();
  const malformed = JSON.parse(JSON.stringify(store));
  malformed.threads[1].reference = { kind: 'briefing', id: -1 };
  expect(() => restoreThreads(JSON.stringify(malformed), null)).toThrow('Contexte');
});
