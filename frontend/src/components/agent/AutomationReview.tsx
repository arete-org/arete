import { useEffect } from 'react';
import type { RunSnapshot } from '@/lib/coachingRuns';
import { GenerationPreview } from './GenerationPreview';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { automationApi, inboxKey, stateLabel, type Interrupt } from '@/lib/automations';
import { discussWithCoach } from '@/lib/coachToday';
import { HumanInputCard } from './HumanInputCard';
import { readableError } from '@/lib/utils';
import { useCoachWords } from '@/lib/coachName';
import { invalidateAfterSession } from '@/lib/queryKeys';

const LIVE_STATES = new Set(['queued', 'running', 'waiting', 'ready']);

const actionLabels: Record<string, string> = {
  apply_plan_changes: 'Ajuster le planning ensemble', preview_plan_changes: 'Préparer un ajustement',
  create_planned_session: 'Ajouter une séance', update_planned_session: 'Ajuster la séance', set_session_prescription: 'Modifier les étapes', delete_planned_session: 'Supprimer la séance',
  save_workout: 'Enregistrer la séance', update_workout: 'Corriger la séance', append_journal: 'Compléter le journal',
  export_garmin_sessions: 'Envoyer vers Garmin', sync_garmin_activities: 'Importer depuis Garmin',
};
function label(name: string) { return actionLabels[name] ?? name.replaceAll('_', ' '); }

function Decision({ runId, item }: { runId: string; item: Interrupt }) {
  const client = useQueryClient();
  return <HumanInputCard item={item} onDecision={async decision => {
    await automationApi.decide(runId,item,decision);
    await client.invalidateQueries({queryKey:['automation-run',runId]});
    await client.invalidateQueries({queryKey:inboxKey});
  }} />;
}

/** The existing Chiron shell owns navigation, focus, size and the preserved chat draft. */
export function AutomationReview({ id }: { id: string }) {
  const coach = useCoachWords();
  const client = useQueryClient();
  const observation = useQuery<RunSnapshot>({ queryKey: ['coaching-activity','automation',id], enabled: false });
  const query = useQuery({ queryKey: ['automation-run', id], queryFn: () => automationApi.run(id), retry: false, refetchInterval: query => query.state.data && LIVE_STATES.has(query.state.data.state) && observation.data?.state !== 'running' ? 15000 : false });
  const settled = query.data && !LIVE_STATES.has(query.data.state);
  useEffect(() => {
    if (!settled) return;
    // A worker can finish while Planning is cached in this tab. Refresh the
    // facts and source card when its receipt arrives, including partial failures.
    invalidateAfterSession(client);
    void client.invalidateQueries({ queryKey: ['coaching-attention'] });
    void client.invalidateQueries({ queryKey: ['coachEvening'] });
  }, [client, id, settled]);
  if (query.isPending) return <p role="status" className="p-4 text-sm">Chargement du suivi…</p>;
  if (!query.data) return <p role="alert" className="p-4 text-sm text-danger-red">{readableError(query.error)}</p>;
  const run = query.data;
  return <div className="min-h-0 overflow-y-auto p-4 space-y-4">
    {query.isError && <p role="alert" className="text-sm text-danger-red">Actualisation du suivi indisponible : {readableError(query.error)}</p>}
    <p className="text-xs text-text-secondary">{run.definition.title} · {stateLabel[run.state] ?? run.state}</p>
    <GenerationPreview kind="automation" sourceId={id} />
    {run.result && <p className="whitespace-pre-wrap text-sm leading-relaxed">{run.result}</p>}
    {run.error && <p role="alert" className="text-sm text-danger-red">{run.error}</p>}
    {run.interrupts.map(item => <Decision key={item.id} runId={id} item={item} />)}
    {run.effects.some(effect => effect.state !== 'proposed') && <details className="text-xs text-text-secondary"><summary className="min-h-11 cursor-pointer py-3">Actions effectuées</summary>{run.effects.filter(effect => effect.state !== 'proposed').map(effect => <p key={effect.tool_call_id}>{label((effect.arguments.executed ?? effect.arguments.call).name)} · {effect.state === 'completed' ? 'effectuée' : 'issue incertaine, sans rejeu'}</p>)}</details>}
    <button className="min-h-11 text-xs text-text-secondary hover:text-text-primary" onClick={() => discussWithCoach({ kind: 'automation_run', id, mode: 'discussion' })}>En parler {coach.to} ↗</button>
  </div>;
}
