import { ApiError } from './api';
import { authFetch } from './auth';
import { readableError } from './utils';

/** Activity files from any watch (FIT, TCX, GPX), a ZIP of them, or a .gz of one. */
export const ACCEPTED_EXTENSIONS = ['.fit', '.tcx', '.gpx', '.zip', '.gz'] as const;
export const MAX_FILES = 10;
/** The server's own limit per file (self-hosted deployments reach it). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/**
 * What one request may carry: the hosting (Vercel) refuses bodies over 4.5 MB,
 * so the compressed file must stay under it, the form's own bytes included.
 */
export const MAX_SEND_BYTES = 4_400_000;
export const TOO_HEAVY_TO_SEND =
  'Fichier trop lourd pour l’envoi (4,5 Mo max après compression) : importe les fichiers un par un ou exporte une activité plus courte.';
/** The same refusal when this browser cannot compress (no CompressionStream). */
export const TOO_HEAVY_UNCOMPRESSED =
  'Fichier trop lourd pour l’envoi (4,5 Mo max) : ce navigateur ne compresse pas les fichiers ; utilise un navigateur à jour ou exporte une activité plus courte.';

export type ImportStatus = 'imported' | 'duplicate' | 'error';

/** One activity file's outcome, as `POST /activities/import` reports it. */
export interface ImportResult {
  filename: string;
  status: ImportStatus;
  message: string;
  session_id?: number | null;
  duplicate_of?: number | null;
  date?: string | null;
  sport?: string | null;
  duration_sec?: number | null;
  distance_m?: number | null;
  planned_session_id?: number | null;
}

export function isActivityFile(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** The files to send, and an error line for each one refused before sending. */
export function selectFiles(files: File[]): { accepted: File[]; refused: ImportResult[] } {
  const accepted: File[] = [];
  const refused: ImportResult[] = [];
  for (const file of files) {
    const error = !isActivityFile(file.name)
      ? 'Format non pris en charge : importe un fichier .fit, .tcx, .gpx ou .zip.'
      : file.size > MAX_FILE_BYTES
        ? 'Fichier trop volumineux (10 Mo maximum).'
        : accepted.length >= MAX_FILES
          ? `${MAX_FILES} fichiers au maximum par import : dépose les suivants ensuite.`
          : null;
    if (error) refused.push({ filename: file.name, status: 'error', message: error });
    else accepted.push(file);
  }
  return { accepted, refused };
}

/**
 * The bytes to send: gzip-compressed when the browser can, so a large export
 * stays under the hosting's request limit (the server detects gzip itself).
 * Archives and .gz files are already compressed.
 */
async function payload(file: File): Promise<{ body: Blob; tooHeavy: string }> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.zip') || lower.endsWith('.gz')) return { body: file, tooHeavy: TOO_HEAVY_TO_SEND };
  if (typeof CompressionStream === 'undefined') return { body: file, tooHeavy: TOO_HEAVY_UNCOMPRESSED };
  const body = await new Response(file.stream().pipeThrough(new CompressionStream('gzip'))).blob();
  return { body, tooHeavy: TOO_HEAVY_TO_SEND };
}

/** Import one file; a ZIP gives one result per activity inside. Never throws. */
export async function importActivityFile(file: File): Promise<ImportResult[]> {
  try {
    const { body, tooHeavy } = await payload(file);
    if (body.size > MAX_SEND_BYTES) return [{ filename: file.name, status: 'error', message: tooHeavy }];
    const form = new FormData();
    form.append('file', body, file.name);
    const response = await authFetch('/api/activities/import', { method: 'POST', body: form });
    if (!response.ok) throw new ApiError(response.status, await response.text());
    return ((await response.json()) as { results: ImportResult[] }).results;
  } catch (error) {
    return [{ filename: file.name, status: 'error', message: readableError(error) }];
  }
}

/**
 * Import files one after the other (one request each), reporting each step:
 * `onProgress(done, total, results so far)`. Returns every file's result.
 */
export async function importActivities(
  files: File[],
  onProgress: (done: number, total: number, results: ImportResult[]) => void,
): Promise<ImportResult[]> {
  const { accepted, refused } = selectFiles(files);
  const results: ImportResult[] = [...refused];
  onProgress(0, accepted.length, results);
  for (const [index, file] of accepted.entries()) {
    results.push(...(await importActivityFile(file)));
    onProgress(index + 1, accepted.length, [...results]);
  }
  return results;
}

/** The batch in one sentence, for the live region once every file is sent. */
export function summarise(results: ImportResult[]): string {
  const count = (status: ImportStatus) => results.filter((r) => r.status === status).length;
  const parts = [
    [count('imported'), 'importé', 'importés'],
    [count('duplicate'), 'déjà dans Arete', 'déjà dans Arete'],
    [count('error'), 'refusé', 'refusés'],
  ] as const;
  const said = parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n > 1 ? many : one}`);
  return `Import terminé : ${said.join(', ') || 'aucun fichier'}.`;
}
