// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ImportResult } from '@/lib/activityImport';
import { ActivityDropzone } from './ActivityDropzone';

const sending = vi.hoisted(() => ({ finish: (_results: ImportResult[]) => {} }));
vi.mock('@/lib/activityImport', async (original) => ({
  ...(await original<typeof import('@/lib/activityImport')>()),
  importActivities: vi.fn(
    (files: File[], onProgress: (done: number, total: number, results: ImportResult[]) => void) =>
      new Promise<ImportResult[]>((resolve) => {
        onProgress(0, files.length, []);
        sending.finish = resolve;
      })
  ),
}));

afterEach(() => cleanup());

const drop = (zone: HTMLElement, ...names: string[]) =>
  fireEvent.drop(zone, { dataTransfer: { files: names.map((name) => new File(['x'], name)) } });

it('speaks French, accepts every watch’s files and states the sending limit', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ActivityDropzone />
    </MemoryRouter>
  );
  expect(html).toContain('Dépose tes fichiers d’activité ici');
  expect(html).toContain('FIT, TCX, GPX ou ZIP, depuis n’importe quelle montre (10 fichiers, 4,5 Mo par fichier, après compression si ton navigateur la permet)');
  expect(html).toContain('accept=".fit,.tcx,.gpx,.zip,.gz"');
  expect(html).toContain('aria-label="Importer une activité"');
  expect(html).toContain('focus-within:outline');
  expect(html).not.toMatch(/DRAG|browse|Upload|Failed/);
});

it('answers a drop during an import, then announces the batch in a live region', async () => {
  const imported = vi.fn();
  render(
    <MemoryRouter>
      <ActivityDropzone onImported={imported} />
    </MemoryRouter>
  );
  const status = screen.getByRole('status');
  const zone = screen.getByLabelText('Importer une activité');
  drop(zone, 'matin.fit', 'velo.tcx');
  expect(status.textContent).toBe('Import 1 sur 2…');

  drop(zone, 'rando.gpx');
  expect(screen.getByRole('alert').textContent).toBe('Un import est déjà en cours : dépose ces fichiers quand il sera terminé.');
  expect(status.textContent).toBe('Import 1 sur 2…'); // the progress is still what the region says

  const results: ImportResult[] = [
    { filename: 'matin.fit', status: 'imported', message: 'Séance importée.', session_id: 41 },
    { filename: 'velo.tcx', status: 'duplicate', message: 'Doublon', duplicate_of: 7 },
  ];
  await act(async () => sending.finish(results));
  expect(screen.getByRole('status')).toBe(status); // the same region, still mounted
  expect(status.textContent).toBe('Import terminé : 1 importé, 1 déjà dans Arete.');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(imported).toHaveBeenCalledWith(results);
});
