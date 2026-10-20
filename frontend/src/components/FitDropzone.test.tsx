import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FitDropzone } from './FitDropzone';

const noop = async () => {};

it('speaks French when idle and lists recent uploads', () => {
  const html = renderToStaticMarkup(
    <FitDropzone
      onUpload={noop}
      recentUploads={[
        { filename: 'sortie.fit', status: 'success' },
        { filename: 'casse.fit', status: 'error' },
      ]}
    />
  );
  expect(html).toContain('Dépose un fichier .FIT ici');
  expect(html).toContain('ou clique pour parcourir');
  expect(html).toContain('Imports récents');
  expect(html).toContain('Analysé');
  expect(html).toContain('Échec');
  expect(html).not.toMatch(/DRAG|browse|Recent uploads|Parsed|Failed/);
});

it('says the import is running', () => {
  const html = renderToStaticMarkup(<FitDropzone onUpload={noop} isUploading />);
  expect(html).toContain('Import en cours…');
  expect(html).not.toContain('UPLOADING');
});
