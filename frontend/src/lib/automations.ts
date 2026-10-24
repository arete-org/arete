import { fetchAPI } from './api';

export type Trigger = { kind: 'once'; at: string } | { kind: 'daily' | 'weekly'; time: string; weekdays: number[] } | { kind: 'session'; session_key?: string | null; sport?: string | null; session_type?: string | null; delay_minutes: number } | { kind: 'evening' };
export interface Definition { title: string; mission: string; trigger: Trigger; timezone: string }
export interface Automation extends Definition { id: string; state: string; revision: number; next_due_at: string | null }
export type { HumanInterrupt as Interrupt } from './humanInput';
import type { HumanInterrupt as Interrupt } from './humanInput';
export interface Run { id: string; automation_id: string; state: string; due_at: string; result: string | null; error: string | null; model_turns: number; tool_calls: number; active_seconds: number; definition: Definition; interrupts: Interrupt[]; effects: { tool_call_id: string; state: string; arguments: { call: { name: string; args: Record<string, unknown> }; executed?: { name: string; args: Record<string, unknown> } } }[] }
export interface Notice { id: string; kind: string; title: string; body: string; url: string; created_at: string; read_at: string | null; archived_at: string | null; reference: { kind: string; id: string } | null; push: { sent: number; skipped_reason: string | null } | null }
export interface Page<T> { items: T[]; next_offset: number | null }
const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });
export const automationApi = {
  list: (offset = 0) => fetchAPI<Page<Automation>>(`/automations?offset=${offset}`),
  create: (definition: Definition) => fetchAPI<Automation>('/automations', json('POST', { ...definition, activate: true })),
  update: (item: Automation, definition: Definition) => fetchAPI<Automation>(`/automations/${item.id}`, json('PUT', { ...definition, revision: item.revision })),
  state: (item: Automation, state: 'active' | 'paused') => fetchAPI<Automation>(`/automations/${item.id}`, json('PATCH', { revision: item.revision, state })),
  remove: (item: Automation) => fetchAPI<void>(`/automations/${item.id}?revision=${item.revision}`, { method: 'DELETE' }),
  runs: (id: string, offset = 0) => fetchAPI<Page<Run>>(`/automations/${id}/runs?offset=${offset}`),
  run: (id: string) => fetchAPI<Run>(`/automation-runs/${id}`),
  decide: (run: string, interrupt: Interrupt, decision: Record<string, unknown>) => fetchAPI<Run>(`/automation-runs/${run}/interrupts/${interrupt.id}`, json('POST', { revision: interrupt.revision, decision })),
  inbox: (filter = 'todo', offset = 0) => fetchAPI<Page<Notice> & { unread: number }>(`/notifications?filter=${filter}&offset=${offset}`),
  mark: (id: string, change: { read?: boolean; archived?: boolean }) => fetchAPI(`/notifications/${id}`, json('PATCH', change)),
};
export const inboxKey = ['inbox'] as const;
export const automationsKey = ['automations'] as const;
export const stateLabel: Record<string, string> = { proposed: 'À activer', active: 'Actif', paused: 'En pause', queued: 'En attente de passage', running: 'En cours', waiting: 'À traiter', ready: 'Réponse enregistrée · reprise au prochain passage', completed: 'Terminé', failed: 'Erreur', interrupted: 'Interrompu', expired: 'Délai de réponse expiré', missed: 'Échéance manquée', cancelled: 'Annulé' };
export function scheduleLabel(trigger: Trigger) {
  if (trigger.kind === 'evening') return 'Après ta prochaine réponse au message du soir';
  if (trigger.kind === 'once') return new Date(trigger.at).toLocaleString('fr-FR');
  if (trigger.kind === 'session') return `Après enregistrement ${trigger.session_key ? `de la séance ${trigger.session_key}` : 'des prochaines séances'}${trigger.sport ? ` · ${trigger.sport}` : ''}${trigger.session_type ? ` · ${trigger.session_type}` : ''}${trigger.delay_minutes ? ` · délai ${trigger.delay_minutes} min` : ''}`;
  const days = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];
  return `${trigger.kind === 'daily' ? 'Chaque jour' : trigger.weekdays.map(day => days[day]).join(', ')} à ${trigger.time}`;
}
