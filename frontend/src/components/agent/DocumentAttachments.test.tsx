// @vitest-environment jsdom
import { createRef, StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { documentsApi, uploadDocument, type CoachDocument } from '@/lib/documents';
import { DocumentAttachments, type AttachmentsHandle } from './DocumentAttachments';

vi.mock('@/lib/documents', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/documents')>(),
  uploadDocument: vi.fn(),
}));

const doc: CoachDocument = {
  id: 'doc', name: 'plan.md', size: 4, sha256: '0'.repeat(64), status: 'ready',
};
const file = new File(['plan'], 'plan.md', { type: 'text/markdown' });
let signal: AbortSignal;
let finish: (doc: CoachDocument) => void;

beforeEach(() => {
  vi.spyOn(documentsApi, 'list').mockResolvedValue([]);
  vi.mocked(uploadDocument).mockImplementation((_thread, _file, abort) => {
    signal = abort;
    return new Promise((resolve, reject) => {
      finish = resolve;
      abort.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
    });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it('keeps an immediate drop through Strict Mode effect replay without replaying the write', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const selected = vi.fn();
  const busy = vi.fn();
  let started = false;
  render(<StrictMode><QueryClientProvider client={client}>
    <DocumentAttachments threadId="thread" onBusy={busy} onDocuments={selected} ref={handle => {
      // A drop can arrive after layout but before the initial passive effects.
      if (handle && !started) { started = true; handle.upload([file]); }
    }} />
  </QueryClientProvider></StrictMode>);
  await act(async () => { await Promise.resolve(); });
  expect(signal.aborted).toBe(false);
  expect(uploadDocument).toHaveBeenCalledTimes(1);
  expect(busy).toHaveBeenLastCalledWith(true);
  await act(async () => { finish(doc); });
  await waitFor(() => expect(selected).toHaveBeenCalledWith(['doc']));
  await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
});

it('cancels an in-flight upload when its owner actually unmounts', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ref = createRef<AttachmentsHandle>();
  const busy = vi.fn();
  const view = render(<QueryClientProvider client={client}>
    <DocumentAttachments threadId="thread" ref={ref} onBusy={busy} onDocuments={vi.fn()} />
  </QueryClientProvider>);
  act(() => ref.current!.upload([file]));
  expect(signal.aborted).toBe(false);
  await act(async () => { view.unmount(); });
  expect(signal.aborted).toBe(true);
  expect(uploadDocument).toHaveBeenCalledTimes(1);
  expect(busy).toHaveBeenLastCalledWith(false);
});
