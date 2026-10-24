import { fetchAPI, ApiError } from './api';
import { authFetch } from './auth';
import { applyEvent, consumeStream, parseEvent, STREAM_TIMEOUT_MS, type ChatMessage, type StreamEvent } from './agentStream';
import type { HumanInterrupt } from './humanInput';

export interface RunSnapshot { id: string; state: string; revision: number; projection: { seq: number; events: unknown[] } }
export interface CoachingRun { id: string; state: string; interrupts: HumanInterrupt[]; activity: RunSnapshot | null }
export const coachingRuns = {
  read: (id: string) => fetchAPI<CoachingRun>(`/agent/runs/${id}`),
  decide: (id: string, item: HumanInterrupt, decision: Record<string, unknown>) => fetchAPI<CoachingRun>(`/agent/runs/${id}/interrupts/${item.id}`, { method: 'POST', body: JSON.stringify({ revision: item.revision, decision }) }),
  cancel: (id: string) => fetchAPI<CoachingRun>(`/agent/runs/${id}/cancel`, { method: 'POST' }),
  latest: (kind: string, id: string, signal?: AbortSignal) => fetchAPI<RunSnapshot | null>(`/agent/activity?source_kind=${encodeURIComponent(kind)}&source_id=${encodeURIComponent(id)}`, { signal }),
};

/** A snapshot is a complete projection: rebuild it instead of applying deltas twice. */
export function snapshotMessage(snapshot: RunSnapshot, previous: ChatMessage = { role: 'assistant', content: '' }): ChatMessage {
  let result: ChatMessage = { ...previous, content: '', parts: [], activity: [], interrupts: [], workouts: [], sequence: undefined, runId: snapshot.id, error: undefined, interrupted: false };
  if (snapshot.projection.events.length > 12000) throw new Error('Activité trop volumineuse.');
  for (const raw of snapshot.projection.events) {
    const event = parseEvent(JSON.stringify(raw));
    if (event) result = applyEvent(result, { ...event, seq: undefined });
  }
  return { ...result, sequence: snapshot.projection.seq, runState: snapshot.state, pending: snapshot.state === 'running' };
}

export async function resumeRun(id: string, onEvent: (event: StreamEvent) => void, signal: AbortSignal) {
  const response = await authFetch(`/api/agent/runs/${id}/resume`, { method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(STREAM_TIMEOUT_MS)]) });
  if (!response.ok) throw new ApiError(response.status, await response.text());
  if (!response.body) throw new Error('Flux de reprise absent.');
  await consumeStream(response.body, onEvent);
}

/** Observation has a fixed lifetime and never resumes or starts a model. */
export function observeRun(id: string, onSnapshot: (snapshot: RunSnapshot) => void, signal: AbortSignal) {
  return observe(`/api/agent/runs/${id}/events`, onSnapshot, signal, id);
}
export function observeGeneration(kind: string, sourceId: string, onSnapshot: (snapshot: RunSnapshot) => void, signal: AbortSignal) {
  return observe(`/api/agent/activity/events?source_kind=${encodeURIComponent(kind)}&source_id=${encodeURIComponent(sourceId)}`, onSnapshot, signal);
}
async function observe(path: string, onSnapshot: (snapshot: RunSnapshot) => void, signal: AbortSignal, id?: string) {
  const response = await authFetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(STREAM_TIMEOUT_MS)]) });
  if (!response.ok) throw new ApiError(response.status, await response.text());
  if (!response.body) throw new Error('Flux d’activité absent.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', bytes = 0;
  try {
    for (let reads = 0; reads < 12000; reads++) {
      const chunk = await reader.read();
      if (chunk.done) return;
      bytes += chunk.value.byteLength;
      if (bytes > 2_000_000) throw new Error('Activité trop volumineuse.');
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let frames = 0; frames < 151; frames++) {
        const end = buffer.indexOf('\n\n');
        if (end < 0) break;
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (!frame.startsWith('data: ')) continue;
        const event = JSON.parse(frame.slice(6));
        if (event.type === 'error') throw new Error(event.detail);
        if (event.type === 'observation_closed') throw new Error('Suivi en pause après cinq minutes. Actualise pour continuer.');
        if (event.type === 'snapshot') {
          if ((id !== undefined && event.id !== id) || !Array.isArray(event.projection?.events)) throw new Error('Activité reçue invalide.');
          onSnapshot(event);
        }
      }
    }
    throw new Error('Limite de lecture atteinte.');
  } finally { await reader.cancel(); reader.releaseLock(); }
}
