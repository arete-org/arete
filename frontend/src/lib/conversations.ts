import { fetchAPI } from './api';
import { restoreConversation } from './agentConversation';
import { isCoachReference } from './coachToday';
import { isContextWindowUsage } from './agentStream';
import type { CoachThread } from './agentThreads';

export interface ConversationSummary { id: string; title: string; updated_at: string; revision: number; excerpt: string; excerpt_truncated: boolean; url: string }
export interface ConversationPage { items: ConversationSummary[]; next_offset: number | null }
export function archivePayload(thread: CoachThread) {
  // Unsent work belongs to this device. Only actual exchanges enter retrieval.
  return { messages: thread.messages, reference: thread.reference ?? null, context_window_usage: thread.contextWindowUsage ?? null, created_at: thread.createdAt, updated_at: thread.updatedAt };
}
export async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export const conversationsApi = {
  list: async (query = '', offset = 0) => { const result = await fetchAPI<ConversationPage>(`/agent/conversations?q=${encodeURIComponent(query)}&offset=${offset}`, { signal: AbortSignal.timeout(15_000) });
    if (!Array.isArray(result.items) || (result.next_offset !== null && !Number.isSafeInteger(result.next_offset))) throw new Error('Historique invalide.');
    return result;
  },
  read: async (id: string): Promise<CoachThread> => {
    const value = await fetchAPI<{ id: string; title: string; revision: number; title_state: string; messages?: unknown; reference?: unknown; context_window_usage?: unknown; created_at?: number; updated_at?: number }>(`/agent/conversations/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000) });
    if (value.id !== id || !Number.isSafeInteger(value.revision) || typeof value.title !== 'string') throw new Error('Conversation sauvegardée invalide.');
    if (value.reference && !isCoachReference(value.reference)) throw new Error('Référence de conversation invalide.');
    const thread: CoachThread = { id, title: value.title, createdAt: value.created_at ?? Date.now(), updatedAt: value.updated_at ?? Date.now(), messages: restoreConversation(JSON.stringify(value.messages ?? [])), draft: '', reference: value.reference ? value.reference as CoachThread['reference'] : undefined, contextWindowUsage: isContextWindowUsage(value.context_window_usage) ? value.context_window_usage : undefined, archiveRevision: value.revision, titleManual: value.title_state === "manual" };
    thread.archiveDigest = await digest(archivePayload(thread));
    return thread;
  },
  save: async (thread: CoachThread, payloadDigest: string) => { const result = await fetchAPI<{ revision: number; title: string }>(`/agent/conversations/${encodeURIComponent(thread.id)}`, {
    method: 'PUT', signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ ...archivePayload(thread), title: thread.title, revision: thread.archiveRevision ?? 0, write_id: await digest([thread.id, thread.archiveRevision ?? 0, payloadDigest]) }),
  });
    if (!Number.isSafeInteger(result.revision) || result.revision < 1 || typeof result.title !== 'string') throw new Error('Confirmation de sauvegarde invalide.');
    return result;
  },
  remove: (id: string) => fetchAPI(`/agent/conversations/${encodeURIComponent(id)}`, { method: 'DELETE', signal: AbortSignal.timeout(15_000) }),
  rename: (id: string, title: string) => fetchAPI<{ title: string }>(`/agent/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }), signal: AbortSignal.timeout(15_000) }),
};

export function openConversation(id: string) {
  window.dispatchEvent(new CustomEvent('arete:conversation-open', { detail: id }));
  window.dispatchEvent(new Event('arete:coach-open'));
}
