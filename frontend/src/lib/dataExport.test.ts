// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { setTokenGetter } from './auth';
import { DEFAULT_EXPORT_TABLES, downloadExport, EXPORT_TABLES, exportUrl } from './dataExport';

afterEach(() => {
  setTokenGetter(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('exportUrl', () => {
  it('leaves the defaults out of the URL', () => {
    expect(exportUrl({ format: 'zip', tables: [...DEFAULT_EXPORT_TABLES].reverse() })).toBe('/api/export/zip');
  });

  it('names every table once an opt-in one is chosen', () => {
    const url = exportUrl({ format: 'zip', tables: EXPORT_TABLES.map((t) => t.id) });
    expect(new URLSearchParams(url.split('?')[1]).getAll('tables')).toEqual(EXPORT_TABLES.map((t) => t.id));
    expect(DEFAULT_EXPORT_TABLES).not.toContain('activity_streams');
  });

  it('carries the range and the selected tables', () => {
    expect(exportUrl({ format: 'json', start: '2026-01-01', end: '2026-03-31', tables: ['goals', 'journal'] })).toBe(
      '/api/export/json?start=2026-01-01&end=2026-03-31&tables=goals&tables=journal'
    );
  });
});

describe('downloadExport', () => {
  it('downloads through the authenticated fetch under the server’s file name', async () => {
    setTokenGetter(async () => 'jeton');
    const fetchMock = vi.fn(
      async () =>
        new Response('PK', {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename="arete-export-2026-10-10.zip"' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn(() => 'blob:export');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    let downloaded = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });

    await downloadExport({ format: 'zip', tables: DEFAULT_EXPORT_TABLES });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer jeton');
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(downloaded).toBe('arete-export-2026-10-10.zip');
  });

  it('surfaces the server’s advice when the export is too large', async () => {
    const detail = 'Export trop volumineux : choisis une période plus courte.';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail }), { status: 413 })));
    const error = await downloadExport({ format: 'json', tables: ['actual_sessions'] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(413);
    expect((error as ApiError).detail).toBe(detail);
  });
});
