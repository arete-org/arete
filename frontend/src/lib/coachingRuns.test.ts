import { expect, it } from 'vitest';
import fixture from '../../../tests/data/agent-stream-v2.json';
import { applyEvent, parseEvent, type ChatMessage } from './agentStream';
import { restoreConversation } from './agentConversation';
import { snapshotMessage } from './coachingRuns';

it('accepts the same versioned fixtures as Python and retains a pending question on reload', () => {
  let message: ChatMessage = { role: 'assistant', content: '', pending: true };
  for (const raw of fixture) {
    const event = parseEvent(JSON.stringify(raw));
    expect(event).not.toBeNull();
    message = applyEvent(message, event!);
  }
  expect(message.runState).toBe('waiting');
  expect(message.pending).toBe(false);
  expect(message.interrupts?.[0].schema).toHaveProperty('properties.rpe.maximum', 10);
  expect(message.parts?.filter(p => p.kind === 'tool').map(p => p.id)).toEqual(['a','b']);
  const restored = restoreConversation(JSON.stringify([message]))[0];
  expect(restored.interrupts).toEqual(message.interrupts);
  expect(restored.runId).toBe(message.runId);
  expect(restored.interrupted).not.toBe(true);
  expect(() => applyEvent(message, { type: 'token', id: 'x', text: 'secret', run_id: 'other', seq: 20 })).toThrow('autre exécution');
  expect(applyEvent(message, parseEvent(JSON.stringify(fixture[0]))!)).toEqual(message);
});
it('replaces an aggregate snapshot without duplicating streamed text', () => {
  const events = [{ type: 'message', id: 'text', text: 'Bonjour', stream_version: 2, run_id: 'run', seq: 9 }, { type: 'run_status', state: 'running', stream_version: 2, run_id: 'run', seq: 1 }];
  const snapshot = { id: 'run', revision: 1, state: 'running', projection: { events, seq: 9 } };
  const message = snapshotMessage(snapshot);
  expect(snapshotMessage(snapshot, message).content).toBe('Bonjour');
  expect(message.sequence).toBe(9);
});
