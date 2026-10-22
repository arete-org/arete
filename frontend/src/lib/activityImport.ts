import { ApiError } from './api';
import { authFetch } from './auth';
import { readableError } from './utils';

/** Activity files from any watch (FIT, TCX, GPX), a ZIP of them, or a .gz of one. */
export const ACCEPTED_EXTENSIONS = ['.fit', '.tcx', '.gpx', '.zip', '.gz'] as const;
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

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
async function payload(file: File): Promise<Blob> {
  const lower = file.name.toLowerCase();
  if (typeof CompressionStream === 'undefined' || lower.endsWith('.zip') || lower.endsWith('.gz')) return file;
  return new Response(file.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

/** Import one file; a ZIP gives one result per activity inside. Never throws. */
export async function importActivityFile(file: File): Promise<ImportResult[]> {
  try {
    const form = new FormData();
    form.append('file', await payload(file), file.name);
    const response = await authFetch('/api/activities/import', { method: 'POST', body: form });
    if (!response.ok) throw new ApiError(response.status, await response.text());
    const body = (await response.json()) as { results: ImportResult[] };
    return body.results;
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
