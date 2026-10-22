import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ActivityDropzone } from './ActivityDropzone';

it('speaks French and accepts every watch’s files', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ActivityDropzone />
    </MemoryRouter>
  );
  expect(html).toContain('Dépose tes fichiers d’activité ici');
  expect(html).toContain('FIT, TCX, GPX ou ZIP, depuis n’importe quelle montre');
  expect(html).toContain('accept=".fit,.tcx,.gpx,.zip,.gz"');
  expect(html).toContain('aria-label="Importer une activité"');
  expect(html).not.toMatch(/DRAG|browse|Upload|Failed/);
});
