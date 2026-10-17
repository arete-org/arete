// @vitest-environment jsdom
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useConversationArchive } from './useConversationArchive';
import { conversationsApi } from '@/lib/conversations';
import { createThread, type ThreadStore } from '@/lib/agentThreads';

vi.mock('@/lib/conversations', () => ({
  archivePayload: (t: { messages: unknown }) => ({ messages: t.messages }),
  digest: async (value: unknown) => JSON.stringify(value),
  conversationsApi: { save: vi.fn() },
}));
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
beforeEach(() => vi.mocked(conversationsApi.save).mockReset());
afterEach(() => { cleanup(); client.clear(); });
function useArchive() {
  const [state, set] = useState<ThreadStore>(() => { const t = createThread(); t.messages = [{ role: 'user', content: 'Hyrox' }]; return { version: 1, activeId: t.id, threads: [t] }; });
  return { state, set, ...useConversationArchive(state, set, true) };
}
it('acknowledges only the snapshot actually saved while preserving newer work', async () => {
  let resolve!: (r: { revision: number; title: string }) => void;
  vi.mocked(conversationsApi.save).mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue({ revision: 2, title: 'Hyrox' });
  const { result } = renderHook(useArchive, { wrapper });
  await waitFor(() => expect(conversationsApi.save).toHaveBeenCalledTimes(1), { timeout: 2500 });
  act(() => result.current.set(s => ({ ...s, threads: s.threads.map(t => ({ ...t, messages: [...t.messages, { role: 'assistant', content: 'Réponse' }] })) })));
  await act(async () => resolve({ revision: 1, title: 'Hyrox' }));
  expect(result.current.state.threads[0].messages).toHaveLength(2);
  expect(result.current.state.threads[0].archiveDigest).not.toContain('Réponse');
  await waitFor(() => expect(conversationsApi.save).toHaveBeenCalledTimes(2), { timeout: 2500 });
  expect(vi.mocked(conversationsApi.save).mock.calls[1][0].archiveRevision).toBe(1);
});
it('preserves a failed import and retries only on explicit request', async () => {
  vi.mocked(conversationsApi.save).mockRejectedValueOnce(new Error('Conflit')).mockResolvedValue({ revision: 1, title: 'Hyrox' });
  const { result } = renderHook(useArchive, { wrapper });
  await waitFor(() => expect(result.current.error).toContain('Non sauvegardée'), { timeout: 2500 });
  expect(result.current.state.threads[0].archiveRevision).toBeUndefined();
  expect(result.current.state.threads[0].messages[0].content).toBe('Hyrox');
  act(() => result.current.set(s => ({ ...s, threads: s.threads.map(t => ({ ...t, draft: 'Ne pas perdre' })) })));
  await new Promise(resolve => setTimeout(resolve, 1200));
  expect(conversationsApi.save).toHaveBeenCalledTimes(1);
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.state.threads[0].archiveRevision).toBe(1), { timeout: 2500 });
  expect(result.current.state.threads[0].draft).toBe('Ne pas perdre');
});
