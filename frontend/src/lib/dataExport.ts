import { ApiError } from './api';
import { authFetch } from './auth';

interface ExportTableSpec {
  id: string;
  label: string;
  /** Left out of the server's default: it grows too fast for a whole history in one response. */
  optIn?: true;
}

const TABLES = [
  { id: 'actual_sessions', label: 'Séances réalisées' },
  { id: 'planned_sessions', label: 'Séances planifiées' },
  { id: 'daily_metrics', label: 'Santé quotidienne' },
  { id: 'strength_sessions', label: 'Séances de force' },
  { id: 'strength_sets', label: 'Séries de force' },
  { id: 'goals', label: 'Objectifs' },
  { id: 'athlete_facts', label: 'Ce que le coach sait' },
  { id: 'daily_checkins', label: 'Check-ins du matin' },
  { id: 'pain_entries', label: 'Douleurs déclarées' },
  { id: 'weight_entries', label: 'Poids' },
  { id: 'evening_messages', label: 'Messages du soir' },
  { id: 'weekly_reviews', label: 'Bilans hebdomadaires' },
  { id: 'session_feedback', label: 'Retours sur les séances' },
  { id: 'activity_terrain', label: 'Terrain des séances' },
  { id: 'activity_weather', label: 'Météo des séances' },
  { id: 'coach_followups', label: 'Questions de suivi du coach' },
  { id: 'settings', label: 'Réglages' },
  { id: 'exercises', label: 'Exercices de force' },
  { id: 'banister_coefficients', label: 'Modèle de forme' },
  { id: 'documents', label: 'Documents joints (noms)' },
  { id: 'game_profile', label: 'Jeu : profil' },
  { id: 'game_periods', label: 'Jeu : périodes' },
  { id: 'game_weeks', label: 'Jeu : semaines' },
  { id: 'game_owned', label: 'Jeu : apparences' },
  { id: 'automations', label: 'Automatisations' },
  { id: 'notifications', label: 'Notifications reçues' },
  { id: 'coach_attention_claims', label: 'Coach : sujets à suivre' },
  { id: 'coach_attention_days', label: 'Coach : relances par jour' },
  { id: 'journal', label: 'Journal du coach' },
  { id: 'activity_streams', label: 'Courbes détaillées des séances', optIn: true },
  { id: 'conversations', label: 'Conversations sauvegardées', optIn: true },
  { id: 'coach_briefings', label: 'Briefings du coach', optIn: true },
  { id: 'plan_decisions', label: 'Décisions d’adaptation du plan', optIn: true },
  { id: 'athlete_fact_revisions', label: 'Historique de ce que le coach sait', optIn: true },
  { id: 'game_events', label: 'Jeu : séances comptées', optIn: true },
  { id: 'game_ledger', label: 'Jeu : gains', optIn: true },
  { id: 'chat_runs', label: 'Exécutions du chat', optIn: true },
  { id: 'chat_interrupts', label: 'Questions et décisions du chat', optIn: true },
  { id: 'chat_effects', label: 'Reçus des actions du chat', optIn: true },
  { id: 'coaching_run_activity', label: 'Activité des générations', optIn: true },
  { id: 'automation_runs', label: 'Exécutions des automatisations', optIn: true },
  { id: 'automation_interrupts', label: 'Validations demandées', optIn: true },
  { id: 'automation_effects', label: 'Actions des automatisations', optIn: true },
  { id: 'plan_change_sets', label: 'Modifications du plan proposées', optIn: true },
] as const satisfies readonly ExportTableSpec[];

export type ExportTableId = (typeof TABLES)[number]['id'];

/** What the server can export (services/data_export.py). */
export const EXPORT_TABLES: readonly (ExportTableSpec & { id: ExportTableId })[] = TABLES;

/** What never leaves in an export, said plainly on the export screen. */
export const NOT_EXPORTED = [
  'Identifiants et jetons de connexion (Garmin, Google Agenda, notifications)',
  'Contenu des documents joints (il reste dans leur conversation)',
  'Fils du coach non sauvegardés : ils restent dans ce navigateur',
  'États techniques : synchronisations, imports, points de reprise des automatisations, envois vers Garmin',
] as const;

export type ExportFormat = 'zip' | 'json';

/** The server's default selection: every table but the opt-in ones. */
export const DEFAULT_EXPORT_TABLES: ExportTableId[] = EXPORT_TABLES.filter((t) => !t.optIn).map((t) => t.id);

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
  // The server's default selection: keep the URL short.
  const isDefault =
    tables.length === DEFAULT_EXPORT_TABLES.length && DEFAULT_EXPORT_TABLES.every((t) => tables.includes(t));
  if (!isDefault) for (const t of tables) params.append('tables', t);
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
