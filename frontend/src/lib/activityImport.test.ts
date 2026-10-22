import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTokenGetter } from './auth';
import { importActivities, importActivityFile, MAX_FILE_BYTES, selectFiles } from './activityImport';

afterEach(() => {
  setTokenGetter(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const file = (name: string, size = 10) => new File([new Uint8Array(size)], name);

describe('selectFiles', () => {
  it('keeps activity files and explains each refusal in French', () => {
    const big = file('long.fit');
    Object.defineProperty(big, 'size', { value: MAX_FILE_BYTES + 1 });
    const { accepted, refused } = selectFiles([file('a.FIT'), file('b.tcx'), file('c.gpx'), file('d.zip'), file('e.fit.gz'), file('notes.pdf'), big]);
    expect(accepted.map((f) => f.name)).toEqual(['a.FIT', 'b.tcx', 'c.gpx', 'd.zip', 'e.fit.gz']);
    expect(refused).toEqual([
      { filename: 'notes.pdf', status: 'error', message: 'Format non pris en charge : importe un fichier .fit, .tcx, .gpx ou .zip.' },
      { filename: 'long.fit', status: 'error', message: 'Fichier trop volumineux (10 Mo maximum).' },
    ]);
  });

  it('sends ten files at most', () => {
    const { accepted, refused } = selectFiles(Array.from({ length: 12 }, (_, i) => file(`${i}.gpx`)));
    expect(accepted).toHaveLength(10);
    expect(refused.map((r) => r.message)).toEqual([
      '10 fichiers au maximum par import : dépose les suivants ensuite.',
      '10 fichiers au maximum par import : dépose les suivants ensuite.',
    ]);
  });
});

describe('importActivities', () => {
  it('sends one file per request, compressed, and reports progress per file', async () => {
    setTokenGetter(async () => 'jeton');
    const sent: { name: string; gzip: boolean }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const part = (init.body as FormData).get('file') as File;
        const head = new Uint8Array(await part.arrayBuffer()).slice(0, 2);
        sent.push({ name: part.name, gzip: head[0] === 0x1f && head[1] === 0x8b });
        const status = part.name === 'b.tcx' ? 'duplicate' : 'imported';
        return new Response(JSON.stringify({ results: [{ filename: part.name, status, message: status === 'imported' ? 'Séance importée.' : 'Doublon' }] }));
      })
    );
    const steps: [number, number, number][] = [];
    const results = await importActivities([file('a.fit'), file('b.tcx'), file('c.txt')], (done, total, sofar) => steps.push([done, total, sofar.length]));
    expect(sent).toEqual([
      { name: 'a.fit', gzip: true },
      { name: 'b.tcx', gzip: true },
    ]);
    expect(steps).toEqual([[0, 2, 1], [1, 2, 2], [2, 2, 3]]);
    expect(results.map((r) => [r.filename, r.status])).toEqual([
      ['c.txt', 'error'],
      ['a.fit', 'imported'],
      ['b.tcx', 'duplicate'],
    ]);
  });

  it('turns a refused request into that file’s French error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Fichier trop volumineux (10 Mo maximum).' }), { status: 413 })));
    expect(await importActivityFile(file('big.gpx'))).toEqual([
      { filename: 'big.gpx', status: 'error', message: 'Fichier trop volumineux (10 Mo maximum).' },
    ]);
  });
});
