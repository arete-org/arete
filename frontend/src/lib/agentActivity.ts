import type { ChatMessage, ToolPart } from './agentStream';

/** Presentation only: permissions and execution remain server-owned. */
const TOOL_LABELS: Record<string, [running: string, done: string]> = {
  read_file: ['Lecture d’un fichier', 'Fichier consulté'],
  ls: ['Recherche dans tes notes', 'Recherche terminée'],
  glob: ['Recherche dans tes notes', 'Recherche terminée'],
  grep: ['Recherche dans tes notes', 'Recherche terminée'],
  edit_file: ['Mise à jour de tes notes', 'Notes mises à jour'],
  delete: ['Suppression dans tes notes', 'Suppression terminée'],
  append_journal: ['Mise à jour du journal', 'Journal à jour'],
  remember_fact: ['Mise à jour de ton profil', 'Information enregistrée'],
  get_workload: ['Analyse de la charge', 'Charge analysée'],
  get_fitness: ['Analyse de la forme', 'Forme analysée'],
  get_training_advice: ['Préparation des recommandations', 'Analyse terminée'],
  list_recent_sessions: ['Lecture de tes séances', 'Séances consultées'],
  save_workout: ['Enregistrement de la séance', 'Séance enregistrée'],
  get_strength_progress: ['Lecture de ta progression en force', 'Progression en force consultée'],
  list_planned: ['Lecture du planning', 'Planning consulté'],
  inspect_planned_session: ['Lecture des étapes', 'Étapes consultées'],
  list_garmin_devices: ['Recherche des appareils Garmin', 'Appareils consultés'],
  export_garmin_sessions: ['Programmation dans Garmin', 'Action Garmin terminée'],
  reconcile_garmin_session: ['Vérification Garmin', 'Vérification terminée'],
  sync_garmin_activities: ['Synchronisation Garmin', 'Synchronisation terminée'],
  create_planned_session: ['Création d’une séance', 'Séance créée'],
  update_planned_session: ['Modification d’une séance', 'Séance mise à jour'],
  delete_planned_session: ['Suppression d’une séance', 'Séance supprimée'],
};

export function toolLabel(tool: Pick<ToolPart, 'name' | 'status'>): string {
  if (tool.status === 'error') return 'Action non aboutie';
  return TOOL_LABELS[tool.name]?.[tool.status === 'done' ? 1 : 0]
    ?? (tool.status === 'done' ? 'Action terminée' : 'Action en cours');
}

/** A failure stays reported until a later identical call succeeds: the coach
 * fixed its cause (e.g. a Garmin check) and repeated it. Nothing is replayed here. */
export function isRecovered(tool: ToolPart, tools: ToolPart[]): boolean {
  return tool.status === 'error' && tools.some(retry => retry.retryOf === tool.id
    && (retry.status === 'done' || isRecovered(retry, tools)));
}

export function messageTools(message: ChatMessage): ToolPart[] {
  return message.parts?.filter((part): part is ToolPart => part.kind === 'tool') ?? [];
}

/** Replaying the whole prompt can repeat an already-committed write, including
 * one whose reply was lost. Follow-up messages retain the original evidence. */
export function canRetryMessage(message: ChatMessage): boolean {
  return !message.workouts?.length
    && !message.parts?.some(part => part.kind === 'tool' || part.kind === 'calendar_action' || part.kind === 'coach_card');
}

export function hasAnswerText(message: ChatMessage): boolean {
  return !!message.content.trim()
    || !!message.parts?.some(part => part.kind === 'text' && part.text.trim());
}

/** Chiron is thinking: pending, not interrupted, and no answer text yet. Its
 * laurel then turns in the status line instead of heading the message. */
export function isThinking(message: ChatMessage): boolean {
  return message.pending === true && !message.interrupted && !message.error && !hasAnswerText(message);
}
