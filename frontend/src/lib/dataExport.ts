import { ApiError } from './api';
import { authFetch } from './auth';

/** What the server can export (services/data_export.py), in download order. */
export const EXPORT_TABLES = [
  { id: 'actual_sessions', label: 'Séances réalisées' },
  { id: 'planned_sessions', label: 'Séances planifiées' },
  { id: 'daily_metrics', label: 'Santé quotidienne' },
  { id: 'strength_sessions', label: 'Séances de force' },
  { id: 'strength_sets', label: 'Séries de force' },
  { id: 'goals', label: 'Objectifs' },
  { id: 'athlete_facts', label: 'Ce que le coach sait' },
  { id: 'daily_checkins', label: 'Check-ins du matin' },
  { id: 'weekly_reviews', label: 'Bilans hebdomadaires' },
  { id: 'journal', label: 'Journal du coach' },
] as const;

export type ExportTableId = (typeof EXPORT_TABLES)[number]['id'];
export type ExportFormat = 'zip' | 'json';

export interface ExportRequest {
  format: ExportFormat;
  /** Inclusive ISO dates; empty means unbounded. */
  start?: string;
  end?: string;
  tables: ExportTableId[];
}

export function exportUrl({ format, start, end, tables }: ExportRequest): string {
  const params = new URLSearchParams();
  if (start) params.set('start', start);
  if (end) params.set('end', end);
  // Every table is the server's default: keep the URL short.
  if (tables.length < EXPORT_TABLES.length) for (const t of tables) params.append('tables', t);
  const query = params.toString();
  return `/api/export/${format}${query ? `?${query}` : ''}`;
}

function filenameOf(response: Response, fallback: string): string {
  const match = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '');
  return match?.[1] ?? fallback;
}

/**
 * Downloads the export through the authenticated fetch: a plain link would not
 * carry the session token when sign-in is on. Throws ApiError (413 when the
 * export is too large for one response, with the server's French advice).
 */
export async function downloadExport(request: ExportRequest): Promise<void> {
  const response = await authFetch(exportUrl(request));
  if (!response.ok) throw new ApiError(response.status, await response.text());
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filenameOf(response, `arete-export.${request.format}`);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
