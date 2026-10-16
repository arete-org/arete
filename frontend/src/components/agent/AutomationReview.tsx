import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui';
import { automationApi, inboxKey, stateLabel, type Interrupt } from '@/lib/automations';
import { discussWithCoach } from '@/lib/coachToday';
import { readableError } from '@/lib/utils';

const labels: Record<string, string> = {
  date_str: 'Date', date: 'Date', session_id: 'Séance', session_ids: 'Séances', session_type: 'Type', sport: 'Sport',
  target_duration_min: 'Durée (min)', target_distance_km: 'Distance (km)', target_intensity: 'Intensité', target_hr_zone: 'Zone',
  description: 'Description', changes: 'Modification', text: 'Séance', notes: 'Note', rpe: 'Ressenti', revision: 'Révision',
  create_planned_session: 'Ajouter une séance', update_planned_session: 'Ajuster la séance', delete_planned_session: 'Supprimer la séance',
  save_workout: 'Enregistrer la séance', update_workout: 'Corriger la séance', append_journal: 'Compléter le journal',
  export_garmin_sessions: 'Envoyer vers Garmin', sync_garmin_activities: 'Importer depuis Garmin',
};
function label(key: string) { return labels[key] ?? key.replaceAll('_', ' '); }
function valueText(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non';
  if (Array.isArray(value)) return value.map(valueText).join(' · ');
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${label(key)} : ${valueText(item)}`).join(' ; ');
  return String(value);
}
function fields(value: unknown, change: (value: unknown) => void, path = '', depth = 0): ReactNode {
  if (depth > 6) return <p>Modification détaillée à examiner avec Chiron.</p>;
  if (Array.isArray(value)) return value.map((item, index) => <div key={index}>{fields(item, next => change(value.map((old, at) => at === index ? next : old)), `${path} ${index + 1}`, depth + 1)}</div>);
  if (value !== null && typeof value === 'object') return Object.entries(value).map(([key, item]) => <div key={key}>{fields(item, next => change({ ...value, [key]: next }), label(key), depth + 1)}</div>);
  return <label className="grid gap-1 text-xs text-text-secondary">{path}{typeof value === 'boolean' ? <input type="checkbox" checked={value} onChange={e => change(e.target.checked)} /> : <input className="w-full rounded-[var(--radius-control)] border border-border bg-void p-2 text-sm text-text-primary" type={typeof value === 'number' ? 'number' : 'text'} value={value == null ? '' : String(value)} onChange={e => change(typeof value === 'number' ? Number(e.target.value) : e.target.value)} />}</label>;
}

function Decision({ runId, item }: { runId: string; item: Interrupt }) {
  const [answer, setAnswer] = useState('');
  const [editing, setEditing] = useState(false);
  const [args, setArgs] = useState(item.payload.args);
  const client = useQueryClient();
  const action = useMutation({ mutationFn: (decision: Record<string, unknown>) => automationApi.decide(runId, item, decision), retry: false, onSuccess: async () => { await client.invalidateQueries({ queryKey: ['automation-run', runId] }); await client.invalidateQueries({ queryKey: inboxKey }); } });
  const question = item.payload.name === 'ask_athlete';
  const [expired, setExpired] = useState(() => Date.parse(item.expires_at) <= Date.now());
  useEffect(() => {
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, Math.min(2_147_483_647, Date.parse(item.expires_at) - Date.now() + 1)));
    return () => window.clearTimeout(timer);
  }, [item.expires_at]);
  if (item.decision) return <p role="status" className="text-sm text-text-secondary">{item.decision.type === 'respond' ? 'Réponse enregistrée.' : item.decision.type === 'reject' ? 'Proposition refusée.' : 'Décision enregistrée.'}</p>;
  const changes = typeof args.changes === 'object' && args.changes !== null ? args.changes as Record<string, unknown> : args;
  return <section className="space-y-3" aria-label={question ? 'Question du suivi' : 'Proposition du suivi'}>
    <p className="text-sm leading-relaxed">{question ? String(item.payload.args.question) : label(item.payload.name)}</p>
    {!question && <dl className="space-y-1 text-sm">{Object.entries(changes).filter(([key]) => key !== 'revision').map(([key, value]) => <div key={key} className="flex flex-wrap gap-x-2"><dt className="text-text-secondary">{label(key)}</dt><dd>{item.payload.before?.[key] != null && <><span className="text-text-muted">{valueText(item.payload.before[key])}</span> → </>}{valueText(value)}</dd></div>)}</dl>}
    {expired ? <p className="text-xs text-text-muted">Cette demande a expiré.</p> : <>
      {question ? <form className="coach-composer flex items-end gap-2 rounded-[var(--radius-control)] border border-border bg-void p-2 focus-within:border-neon-cyan" onSubmit={e => { e.preventDefault(); action.mutate({ type: 'respond', message: answer }); }}>
        <textarea aria-label="Ta réponse" placeholder="Ta réponse…" rows={1} maxLength={4000} value={answer} onChange={e => setAnswer(e.target.value)} className="coach-composer-input min-h-8 max-h-36 min-w-0 flex-1 resize-none bg-transparent px-1 py-1 text-sm outline-none" />
        <button type="submit" aria-label="Envoyer la réponse" disabled={action.isPending || !answer.trim()} className="flex size-11 shrink-0 items-center justify-center rounded-full bg-shadow text-text-primary disabled:opacity-40"><ArrowUp size={18} /></button>
      </form> : <>
        {editing && <div className="space-y-3">{fields(args, value => setArgs(value as Record<string, unknown>))}</div>}
        <div className="flex flex-wrap items-center gap-2"><Button strong size="sm" loading={action.isPending} onClick={() => action.mutate(editing ? { type: 'edit', edited_action: { name: item.payload.name, args } } : { type: 'approve' })}>Approuver</Button><Button variant="ghost" size="sm" disabled={action.isPending} onClick={() => setEditing(!editing)}>{editing ? 'Annuler' : 'Modifier'}</Button><Button variant="ghost" size="sm" disabled={action.isPending} onClick={() => action.mutate({ type: 'reject', message: 'Refusé par l’athlète' })}>Refuser</Button></div>
      </>}
    </>}
    {action.error && <p role="alert" className="text-xs text-danger-red">{readableError(action.error)}</p>}
  </section>;
}

/** The existing Chiron shell owns navigation, focus, size and the preserved chat draft. */
export function AutomationReview({ id }: { id: string }) {
  const query = useQuery({ queryKey: ['automation-run', id], queryFn: () => automationApi.run(id), refetchInterval: 15000 });
  if (query.isPending) return <p role="status" className="p-4 text-sm">Chargement du suivi…</p>;
  if (!query.data) return <p role="alert" className="p-4 text-sm text-danger-red">{readableError(query.error)}</p>;
  const run = query.data;
  return <div className="min-h-0 overflow-y-auto p-4 space-y-4">
    <p className="text-xs text-text-secondary">{run.definition.title} · {stateLabel[run.state] ?? run.state}</p>
    {run.result && <p className="whitespace-pre-wrap text-sm leading-relaxed">{run.result}</p>}
    {run.error && <p role="alert" className="text-sm text-danger-red">{run.error}</p>}
    {run.interrupts.map(item => <Decision key={item.id} runId={id} item={item} />)}
    {run.effects.some(effect => effect.state !== 'proposed') && <details className="text-xs text-text-secondary"><summary className="min-h-11 cursor-pointer py-3">Actions effectuées</summary>{run.effects.filter(effect => effect.state !== 'proposed').map(effect => <p key={effect.tool_call_id}>{label((effect.arguments.executed ?? effect.arguments.call).name)} · {effect.state === 'completed' ? 'effectuée' : 'issue incertaine, sans rejeu'}</p>)}</details>}
    <button className="min-h-11 text-xs text-text-secondary hover:text-text-primary" onClick={() => discussWithCoach({ kind: 'automation_run', id, mode: 'discussion' })}>En parler à Chiron ↗</button>
  </div>;
}
