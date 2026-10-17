// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { applyEvent, consumeStream, parseEvent, runAgentStream, type ChatMessage } from './agentStream';
import { chartPart, type ChartCardData } from './chartCards';
import { restoreConversation } from './agentConversation';
import { archivePayload, hasLocalCharts, restoreLocalCharts } from './conversations';
import { addThread, createThread, emptyStore, restoreThreads, saveThreads, THREADS_KEY, updateThread } from './agentThreads';

const chart: ChartCardData = {
  version: 1, id: 'a'.repeat(64), title: 'Distance hebdomadaire', summary: '20 puis 40 km. Source : séances enregistrées.',
  html: `<svg viewBox="0 0 320 200">${'<circle cx="20" cy="20" r="2"/>'.repeat(100)}</svg>`, height_px: 280,
};
const empty: ChatMessage = { role: 'assistant', content: '', parts: [], pending: true };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it('archives the chart summary, preserves local charts on refresh and never crosses threads', () => {
  const thread = createThread();
  thread.messages = [{ role: 'assistant', content: chart.summary, pending: false, parts: [
    { kind: 'tool', id: 'render', name: 'render_chart', status: 'done', args: { text: chart.html, truncated: false } },
    chartPart(chart),
  ] }];
  const payload = archivePayload(thread);
  expect(JSON.stringify(payload)).not.toContain('<svg');
  expect(payload.messages[0].parts).toEqual([{ kind: 'text', id: chart.id, text: `${chart.title}\n\n${chart.summary}` }]);
  const remote = { ...thread, messages: restoreConversation(JSON.stringify(payload.messages)) };
  const restored = restoreLocalCharts(remote, thread);
  expect(restored.messages[0].parts).toEqual([chartPart(chart)]);
  expect(hasLocalCharts(restored)).toBe(true);
  expect(archivePayload(restored)).toEqual(archivePayload(remote));
  expect(hasLocalCharts(restoreLocalCharts(remote, createThread()))).toBe(false);
  expect(hasLocalCharts(restoreLocalCharts(remote))).toBe(false);
  remote.messages[0].parts = [{ kind: 'text', id: chart.id, text: 'Résumé corrigé ailleurs' }];
  expect(hasLocalCharts(restoreLocalCharts(remote, thread))).toBe(false);
});

it('decodes a full chart across byte boundaries, once, between text parts', async () => {
  const events = [
    { type: 'token', id: 'before', text: 'Voici la distance.' },
    { type: 'chart_card', ...chart }, { type: 'chart_card', ...chart },
    { type: 'message', id: 'after', text: 'La distance a doublé.' },
    { type: 'done', message: { role: 'assistant', content: 'La distance a doublé.' } },
  ];
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.slice(index, index + 3));
    controller.close();
  } });
  let message = empty;
  await consumeStream(stream, event => { message = applyEvent(message, event); });
  expect(message.parts?.map(part => part.kind)).toEqual(['text', 'chart_card', 'text']);
  expect(message.parts?.[1]).toEqual(chartPart(chart));
  expect(chart.html.length).toBeGreaterThan(2000);
  expect(restoreConversation(JSON.stringify([message]))[0].parts).toEqual(message.parts);
});

it('rejects bad envelopes, conflicting IDs and excessive card counts', () => {
  for (const change of [{ version: 2 }, { id: 'wrong' }, { height_px: 0 }, { height_px: 280.5 }, { title: ' ' }, { summary: 'x'.repeat(601) }, { html: '🏃'.repeat(4097) }]) {
    const invalid = { ...chart, ...change };
    expect(() => parseEvent(JSON.stringify({ type: 'chart_card', ...invalid }))).toThrow();
    expect(() => restoreConversation(JSON.stringify([{ ...empty, parts: [{ kind: 'chart_card', ...invalid }] }]))).toThrow();
  }
  let message = applyEvent(empty, { type: 'chart_card', ...chart });
  expect(() => applyEvent(message, { type: 'chart_card', ...chart, html: chart.html + 'different' })).toThrow('changé');
  for (const id of ['b', 'c', 'd']) message = applyEvent(message, { type: 'chart_card', ...chart, id: id.repeat(64) });
  expect(() => applyEvent(message, { type: 'chart_card', ...chart, id: 'e'.repeat(64) })).toThrow('quatre');
});

it('keeps cards in the originating thread through interruption and restores legacy text', () => {
  const original = emptyStore();
  const first = original.activeId;
  original.threads[0].messages = [{ role: 'user', content: 'Distance ?' }, empty];
  const second = createThread();
  let store = addThread(original, second);
  store = updateThread(store, first, thread => ({ ...thread, messages: [thread.messages[0], applyEvent(empty, { type: 'chart_card', ...chart })] }));
  const restored = restoreThreads(JSON.stringify(store), null);
  expect(restored.activeId).toBe(second.id);
  expect(restored.threads.find(thread => thread.id === second.id)?.messages).toEqual([]);
  const answer = restored.threads.find(thread => thread.id === first)?.messages[1];
  expect(answer?.interrupted).toBe(true);
  expect(answer?.parts).toEqual([chartPart(chart)]);
  expect(restoreConversation(JSON.stringify([{ role: 'assistant', content: 'Ancienne réponse.' }]))[0].content).toBe('Ancienne réponse.');
});

it('reports storage saturation without overwriting previously saved charts', () => {
  const store = emptyStore();
  store.threads[0].messages = [applyEvent(empty, { type: 'chart_card', ...chart })];
  expect(saveThreads(store)).toBeNull();
  const previous = localStorage.getItem(THREADS_KEY);
  const huge = { ...chart, html: `<svg viewBox="0 0 320 200"><desc>${'x'.repeat(16000)}</desc></svg>` };
  store.threads[0].messages = Array.from({ length: 260 }, () => ({ ...empty, parts: [chartPart(huge)] }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(saveThreads(store)).toContain('Sauvegarde indisponible');
  expect(localStorage.getItem(THREADS_KEY)).toBe(previous);
});

it('announces support without replaying chart HTML as model history', async () => {
  const bytes = new TextEncoder().encode('data: {"type":"done","message":{"role":"assistant","content":"Suite."}}\n\n');
  const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } })));
  vi.stubGlobal('fetch', fetchMock);
  await runAgentStream([{ ...empty, content: chart.summary, parts: [chartPart(chart)] }], { page: 'analytics', path: '/analytics', params: {} }, () => {}, new AbortController().signal, 'thread');
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.supports_chart_cards).toBe(true);
  expect(body.messages).toEqual([{ role: 'assistant', content: chart.summary }]);
  expect(fetchMock.mock.calls[0][1].body).not.toContain('<svg');
});
