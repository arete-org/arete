import { describe, expect, it, vi } from 'vitest';
import {
  applyEvent,
  consumeStream,
  REQUEST_WINDOW_MESSAGES,
  requestWindow,
  runAgentStream,
  settleMessage,
  type ChatMessage,
  type StreamEvent,
} from './agentStream';
import { restoreConversation } from './agentConversation';

const empty: ChatMessage = { role: 'assistant', content: '', parts: [] };
const preview = { text: '{}', truncated: false };
const done: StreamEvent = {
  type: 'done',
  message: { role: 'assistant', content: 'Réponse' },
};
const frame = (event: StreamEvent) => `data: ${JSON.stringify(event)}\r\n\r\n`;
function stream(text: string, split = 1) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += split)
        controller.enqueue(bytes.slice(i, i + split));
      controller.close();
    },
  });
}

describe('SSE transport', () => {
  it('sends the stable conversation ID without UI-only history fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream(frame(done))));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await runAgentStream(
        [{ role: 'user', content: 'Demain ?', pending: false, parts: [] }],
        { page: 'planning', path: '/planning', params: {} },
        () => {},
        new AbortController().signal,
        'dfe771b8-661a-46af-9cee-dce80e6bc304'
      );
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        messages: [{ role: 'user', content: 'Demain ?' }],
        panel_context: { page: 'planning', path: '/planning' },
        thread_id: 'dfe771b8-661a-46af-9cee-dce80e6bc304',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('decodes split UTF-8 and CRLF frames without dropping tokens', async () => {
    const events: StreamEvent[] = [];
    await consumeStream(
      stream(
        frame({ type: 'token', id: 'm1', text: 'Séance 🏃' }) + frame(done)
      ),
      (e) => events.push(e)
    );
    expect(events).toEqual([
      { type: 'token', id: 'm1', text: 'Séance 🏃' },
      done,
    ]);
  });
  it('rejects a premature disconnect', async () => {
    await expect(
      consumeStream(
        stream(frame({ type: 'token', id: 'm1', text: 'Début' })),
        () => {}
      )
    ).rejects.toThrow('interrompue');
  });
  it('rejects malformed JSON and malformed event shapes', async () => {
    await expect(
      consumeStream(stream('data: {broken}\n\n'), () => {})
    ).rejects.toThrow();
    await expect(
      consumeStream(
        stream('data: {"type":"tool_end","name":"read_file"}\n\n'),
        () => {}
      )
    ).rejects.toThrow('invalide');
  });
  it('surfaces server errors', async () => {
    await expect(
      consumeStream(
        stream(frame({ type: 'error', detail: 'Provider unavailable' })),
        () => {}
      )
    ).rejects.toThrow('Provider unavailable');
  });
});

describe('Independent surfaces', () => {
  it('matches parallel same-name calls by ID even when they finish out of order', () => {
    let state = empty;
    for (const id of ['a', 'b'])
      state = applyEvent(state, {
        type: 'tool_start',
        id,
        name: 'read_file',
        args: preview,
      });
    state = applyEvent(state, {
      type: 'tool_end',
      id: 'b',
      name: 'read_file',
      status: 'error',
      output: preview,
      elapsed_ms: 10,
    });
    expect(state.parts).toMatchObject([
      { id: 'a', status: 'running' },
      { id: 'b', status: 'error' },
    ]);
    state = applyEvent(state, {
      type: 'tool_end',
      id: 'a',
      name: 'read_file',
      status: 'done',
      output: preview,
      elapsed_ms: 20,
    });
    expect(state.parts).toMatchObject([
      { id: 'a', status: 'done' },
      { id: 'b', status: 'error' },
    ]);
  });
  it('keeps model turns separate and reconciles final snapshots without duplication', () => {
    let state = applyEvent(empty, {
      type: 'token',
      id: 'm1',
      text: 'Je consulte.',
    });
    state = applyEvent(state, {
      type: 'tool_start',
      id: 't1',
      name: 'get_fitness',
      args: preview,
    });
    state = applyEvent(state, { type: 'token', id: 'm2', text: '**Ré' });
    state = applyEvent(state, {
      type: 'message',
      id: 'm2',
      text: '**Réponse**',
    });
    state = applyEvent(state, {
      type: 'done',
      message: { role: 'assistant', content: '**Réponse**' },
    });
    expect(state.parts).toMatchObject([
      { kind: 'text', text: 'Je consulte.' },
      { kind: 'tool', status: 'interrupted' },
      { kind: 'text', text: '**Réponse**' },
    ]);
    expect(state.content).toBe('**Réponse**');
  });
  it('preserves partial text on errors and does not mark unfinished tools successful', () => {
    let state = applyEvent(empty, { type: 'token', id: 'm', text: 'Début' });
    state = applyEvent(state, {
      type: 'tool_start',
      id: 't',
      name: 'read_file',
      args: preview,
    });
    state = settleMessage(state, 'Connexion perdue');
    expect(state.content).toBe('Début');
    expect(state.error).toBe('Connexion perdue');
    expect(state.parts?.[1]).toMatchObject({ status: 'interrupted' });
  });
  it('migrates existing conversations and restores failures accurately', () => {
    const old = restoreConversation(
      JSON.stringify([
        {
          role: 'assistant',
          content: '**Bonjour**',
          steps: [{ name: 'read_file', status: 'running' }],
        },
      ])
    );
    expect(old[0].parts).toMatchObject([
      { kind: 'tool', status: 'interrupted' },
      { kind: 'text', text: '**Bonjour**' },
    ]);
    const failed = applyEvent(empty, {
      type: 'tool_end',
      id: 't',
      name: 'read_file',
      status: 'error',
      output: preview,
      elapsed_ms: 3,
    });
    expect(
      restoreConversation(JSON.stringify([failed]))[0].parts?.[0]
    ).toMatchObject({ status: 'error' });
  });
});

describe('request window', () => {
  const turn = (i: number): ChatMessage[] => [
    { role: 'user', content: `question ${i}` },
    { role: 'assistant', content: `réponse ${i}` },
  ];

  it('sends a short thread whole', () => {
    const history = [...turn(1), { role: 'user', content: 'suite' } as ChatMessage];
    expect(requestWindow(history)).toEqual(history);
  });

  it('sends only the tail of a long thread, opening on a question', () => {
    const history = [
      ...Array.from({ length: 40 }, (_, i) => turn(i)).flat(),
      { role: 'user', content: 'dernière' } as ChatMessage,
    ];
    const window = requestWindow(history);
    expect(window.length).toBeLessThanOrEqual(REQUEST_WINDOW_MESSAGES);
    expect(window[0].role).toBe('user');
    expect(window.at(-1)?.content).toBe('dernière');
  });
});

describe('retired optional events', () => {
  it('ignores a legacy suggestion without failing the answer or exposing a draft', async () => {
    const events: StreamEvent[] = [];
    await consumeStream(stream('data: {"type":"suggestion","text":"Une action inventée"}\n\n' + frame(done)), e => events.push(e));
    expect(events).toEqual([done]);
  });
});
