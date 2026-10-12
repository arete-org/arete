import { beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeGarminSync, streamGarminSync } from './garminSync';
import { authFetch } from './auth';

vi.mock('./auth', () => ({ authFetch: vi.fn() }));
beforeEach(() => { vi.mocked(authFetch).mockReset(); });
const result = { type: 'done', success: true, activities_synced: 1, activities_merged: 0, activities_matched: 0, activities_skipped: 0, errors: [], last_activity_date: null };
const progress = { type: 'progress', stage: 'fit', completed: 1, total: 3, activity_name: 'Séance à pied' };
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\r\n\r\n`;
function body(text: string, split = false) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) {
    if (split) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    else controller.enqueue(bytes);
    controller.close();
  } });
}

describe('Garmin progress transport', () => {
  it('handles split UTF-8, CRLF and several events in one chunk', async () => {
    for (const split of [false, true]) {
      const received = vi.fn();
      expect(await consumeGarminSync(body(frame(progress) + frame(result), split), received)).toEqual(result);
      expect(received).toHaveBeenCalledExactlyOnceWith(progress);
    }
  });
  it('requires a terminal result even after all activities are processed', async () => {
    await expect(consumeGarminSync(body(frame({ ...progress, completed: 3 })), vi.fn())).rejects.toThrow('Suivi interrompu');
  });
  it('reports server errors and rejects invalid counters', async () => {
    await expect(consumeGarminSync(body(frame({ type: 'error', detail: 'Garmin indisponible' })), vi.fn())).rejects.toThrow('Garmin indisponible');
    await expect(consumeGarminSync(body(frame({ ...progress, completed: 4 })), vi.fn())).rejects.toThrow('invalide');
  });
  it('preserves partial results instead of inventing a complete success', async () => {
    const partial = { ...result, errors: ['FIT indisponible'] };
    expect(await consumeGarminSync(body(frame(partial)), vi.fn())).toEqual(partial);
  });
  it('sends one authenticated POST and never retries HTTP failures', async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(new Response('{"detail":"Connecte Garmin"}', { status: 409 }));
    await expect(streamGarminSync({ max_activities: 50 }, vi.fn(), new AbortController().signal)).rejects.toThrow('Connecte Garmin');
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(authFetch).toHaveBeenCalledWith('/api/garmin/sync/activities/stream', expect.objectContaining({ method: 'POST', body: '{"max_activities":50}' }));
  });
});

describe('complete Garmin history', () => {
  const first = { ...result, activities_synced: 0, activities_skipped: 20, next_history_offset: 20, history_anchor: 321 };
  const last = { ...result, next_history_offset: null, history_anchor: null };
  const respond = (terminal: unknown, events: unknown[] = []) => new Response(body(events.map(frame).join('') + frame(terminal)));

  it('advances past skipped pages, aggregates results and keeps progress monotonic', async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(respond(first, [
      { ...progress, completed: 20, total: 20 },
      { ...progress, stage: 'finalizing', completed: 0, total: null },
    ])).mockResolvedValueOnce(respond({ ...last, errors: ['FIT indisponible'] }, [
      { ...progress, completed: 0, total: null },
      { ...progress, completed: 1, total: 1 },
    ]));
    const received = vi.fn();
    const done = await streamGarminSync({ full_history: true, download_fit: true }, received, new AbortController().signal);
    expect(done).toMatchObject({ success: true, activities_synced: 1, activities_skipped: 20, errors: ['FIT indisponible'] });
    expect(received.mock.calls.map(([p]) => p.completed)).toEqual([20, 20, 20, 21]);
    expect(received.mock.calls.every(([p]) => p.total === null && p.full_history)).toBe(true);
    expect(vi.mocked(authFetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { download_fit: true, max_activities: 20, history_offset: 0 },
      { download_fit: true, max_activities: 20, history_offset: 20, history_anchor: 321 },
    ]);
  });

  it('requires the final empty page for an exact batch and accepts an empty archive', async () => {
    for (const pages of [[{ ...last, activities_synced: 0 }], [first, { ...last, activities_synced: 0 }]]) {
      vi.mocked(authFetch).mockReset();
      for (const page of pages) vi.mocked(authFetch).mockResolvedValueOnce(respond(page));
      expect((await streamGarminSync({ full_history: true }, vi.fn(), new AbortController().signal)).success).toBe(true);
      expect(authFetch).toHaveBeenCalledTimes(pages.length);
    }
  });

  it('imports more than 200 activities without treating the per-request cap as a total', async () => {
    for (let page = 0; page < 11; page++) {
      vi.mocked(authFetch).mockResolvedValueOnce(respond({ ...first, activities_synced: 20, activities_skipped: 0, next_history_offset: (page + 1) * 20 }));
    }
    vi.mocked(authFetch).mockResolvedValueOnce(respond(last));
    expect(await streamGarminSync({ full_history: true }, vi.fn(), new AbortController().signal)).toMatchObject({ success: true, activities_synced: 221 });
    expect(authFetch).toHaveBeenCalledTimes(12);
  });

  it('fails explicitly when the archive exceeds the hard activity limit', async () => {
    vi.mocked(authFetch).mockImplementation(async (_url, init) => {
      const offset = JSON.parse(String(init?.body)).history_offset;
      return respond({ ...first, next_history_offset: offset + 20 });
    });
    await expect(streamGarminSync({ full_history: true }, vi.fn(), new AbortController().signal)).rejects.toThrow('Import incomplet');
    expect(authFetch).toHaveBeenCalledTimes(1001);
  });

  it.each([result, { ...first, next_history_offset: 0 }, { ...first, history_anchor: null }])('rejects missing or invalid continuation metadata', async terminal => {
    vi.mocked(authFetch).mockResolvedValueOnce(respond(terminal));
    await expect(streamGarminSync({ full_history: true }, vi.fn(), new AbortController().signal)).rejects.toThrow('Import incomplet');
    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  it('stops after a failed page, retaining prior committed counts', async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(respond(first)).mockResolvedValueOnce(respond({ ...last, success: false, errors: ['Garmin indisponible'] }));
    expect(await streamGarminSync({ full_history: true }, vi.fn(), new AbortController().signal)).toMatchObject({ success: false, activities_skipped: 20, errors: ['Garmin indisponible'] });
    expect(authFetch).toHaveBeenCalledTimes(2);
  });

  it('never retries a broken stream or starts another page after cancellation', async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(respond(first)).mockResolvedValueOnce(new Response(body(frame(progress))));
    await expect(streamGarminSync({ full_history: true }, vi.fn(), new AbortController().signal)).rejects.toThrow('Suivi interrompu');
    expect(authFetch).toHaveBeenCalledTimes(2);
    vi.mocked(authFetch).mockReset();
    const controller = new AbortController();
    vi.mocked(authFetch).mockImplementationOnce(async () => { controller.abort(); return respond(first); });
    await expect(streamGarminSync({ full_history: true }, vi.fn(), controller.signal)).rejects.toThrow('Suivi interrompu');
    expect(authFetch).toHaveBeenCalledTimes(1);
  });
});
