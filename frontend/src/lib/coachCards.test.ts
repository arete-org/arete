import { expect, it } from 'vitest';
import { applyEvent, consumeStream, type ChatMessage, type StreamEvent } from './agentStream';
import { restoreConversation } from './agentConversation';

it('keeps confirmed references through duplicate SSE events, interruption and reload', () => {
  const event: StreamEvent = { type: 'coach_card', id: 'fact:12', ref_kind: 'fact', ref_id: 12 };
  const initial: ChatMessage = { role: 'assistant', content: '', pending: true, parts: [] };
  const message = applyEvent(applyEvent(initial, event), event);
  const restored = restoreConversation(JSON.stringify([message]));
  expect(restored[0].parts).toEqual([{ kind: 'coach_card', id: 'fact:12', ref_kind: 'fact', ref_id: 12 }]);
  expect(restored[0].interrupted).toBe(true);
});

it('rejects inconsistent reference identities from storage and SSE', async () => {
  const card = { kind: 'coach_card', id: 'fact:12', ref_kind: 'followup', ref_id: 12 };
  expect(() => restoreConversation(JSON.stringify([{ role: 'assistant', content: '', parts: [card] }]))).toThrow();
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ ...card, type: 'coach_card' })}\n\n`);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  await expect(consumeStream(stream, () => {})).rejects.toThrow();
});
