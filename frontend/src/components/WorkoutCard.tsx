import { inputClasses } from '@/components/ui/Input';
import { Link } from 'react-router-dom';
import { markWorkout, measureWorkout } from '@/lib/workoutPerformance';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, CircleAlert, ExternalLink, Loader2 } from 'lucide-react';
import { PrescriptionEditor } from './PrescriptionEditor';
import { Modal, ModalHeader } from './ui';
import { useWorkoutActions } from '@/hooks/useWorkoutActions';
import { exportLabel, GENERIC_STEPS_LABEL, PARSED_STEPS_LABEL, workoutApi, workoutKey, type WorkoutSession, type WorkoutView } from '@/lib/workouts';
import { parseLocalDate } from '@/lib/dates';
import type { Prescription, Target } from '@/lib/documents';
import { formatClock, formatPace } from '@/lib/utils';

const input = inputClasses('cyan', 'text-sm');
const sports: Record<string, string> = { running: 'Course', cycling: 'Vélo', swimming: 'Natation', strength: 'Musculation', walking: 'Marche', hiking: 'Randonnée' };

function EditWorkout({ session, onClose, onResult }: { session: WorkoutSession; onClose: () => void; onResult?: (text: string) => void }) {
  const [day, setDay] = useState(session.date);
  const [description, setDescription] = useState(session.description ?? '');
  // A generic estimate is not a starting point: saving it would bless the template.
  const [prescription, setPrescription] = useState<Prescription>((!session.needs_steps && session.prescription) || { version: 1, steps: [] });
  const actions = useWorkoutActions(onResult);
  const save = async () => {
    if (await actions.run({ kind: 'edit', session, date: day, description, prescription })) onClose();
  };
  return <Modal open onClose={() => { if (!actions.busy) onClose(); }} className="max-w-xl max-h-[90dvh] overflow-y-auto">
    <ModalHeader title="Modifier la séance" onClose={() => { if (!actions.busy) onClose(); }} />
    <fieldset disabled={actions.busy} className="mt-4 space-y-4">
      <label className="block space-y-1 text-sm">Date<input type="date" className={input} value={day} onChange={e => setDay(e.target.value)} /></label>
      <label className="block space-y-1 text-sm">Titre<input className={input} value={description} maxLength={500} onChange={e => setDescription(e.target.value)} /></label>
      {session.derived && !session.needs_steps && <p className="text-xs text-text-muted">Ces étapes étaient dérivées du planning. Les enregistrer fixe cette prescription et la retire de l’adaptation automatique.</p>}
      {session.parsed && <p className="text-xs text-text-muted">Ces étapes sont lues dans la description. Les enregistrer les fixe : modifier ensuite le titre ne les changera plus.</p>}
      <PrescriptionEditor sport={session.sport} value={prescription} onChange={setPrescription} />
      <p className="text-xs text-text-muted">Enregistrement dans Arete. Un nouvel envoi sera nécessaire pour mettre Garmin à jour.</p>
      {actions.error && <p role="alert" className="text-sm text-danger-red">{actions.error}</p>}
      <button className="rounded-lg bg-neon-cyan/15 px-4 py-2.5 text-sm font-medium text-neon-cyan disabled:opacity-40" disabled={!day || !description.trim() || !prescription.steps.length} onClick={() => void save()}>{actions.busy ? 'Enregistrement…' : 'Enregistrer'}</button>
    </fieldset>
  </Modal>;
}

/** `WorkoutSelection` reads and polls every card of its list; a card subscribes to its entry. */
export function WorkoutCard({ sessionId, initial, readError, compact = false, selected = false, onSelect, onResult, locked = false }: {
  sessionId: number; initial?: WorkoutView; readError?: string; compact?: boolean; selected?: boolean;
  onSelect?: (session: WorkoutSession, checked: boolean) => void; onResult?: (text: string) => void; locked?: boolean;
}) {
  const actions = useWorkoutActions(onResult);
  const pending = actions.pendingIds.has(sessionId);
  const query = useQuery({ queryKey: workoutKey(sessionId), queryFn: () => workoutApi.inspect(sessionId), enabled: false });
  const [editing, setEditing] = useState(false);
  const view = query.data ?? initial;
  useEffect(() => {
    if (view) {
      markWorkout('workout:card-visible');
      measureWorkout('workout:event-to-card', 'coach:workout-received', 'workout:card-visible');
    }
  }, [view]);
  if (!view) return <div className="rounded-xl border border-text-muted/15 p-4 text-sm text-text-muted" role="status">{readError ?? 'Lecture de la séance…'}</div>;
  const { session, export: state } = view;
  const working = pending || state?.state === 'working';
  const uncertain = state && ['uncertain', 'conflict'].includes(state.state);
  const sent = state && ['scheduled', 'transfer_requested'].includes(state.state);
  const canEdit = !!query.data && !working && !uncertain && !locked;
  const selectable = session.exportable !== false && !working && !uncertain && !locked && !readError;
  return <div id={compact ? `workout-${sessionId}` : undefined} className={compact ? 'mt-3 border-t border-text-muted/15 pt-3' : 'my-3 rounded-xl border border-text-muted/20 bg-shadow/30 p-4'} data-testid={`workout-${sessionId}`}>
    <div className="flex items-start gap-3">
      {onSelect && <input type="checkbox" className="mt-1 size-4 accent-neon-cyan" aria-label={`Sélectionner ${session.description || session.sport}`} checked={selected} disabled={!selected && !selectable} onChange={e => onSelect(session, e.target.checked)} />}
      <div className="min-w-0 flex-1">
        {!compact && <>
          <p className="text-xs text-text-muted">{parseLocalDate(session.date).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })} · {sports[session.sport] ?? session.sport}</p>
          <h4 className="mt-1 text-sm font-semibold text-text-primary">{session.description || 'Séance prévue'}</h4>
        </>}
        <p className="mt-1 text-sm leading-relaxed text-text-secondary">{session.summary || 'Étapes à compléter'}</p>
        {session.parsed && <p className="mt-1 text-xs text-text-muted">{PARSED_STEPS_LABEL}</p>}
        {session.derived && <p className="mt-1 text-xs text-text-muted">{session.needs_steps ? GENERIC_STEPS_LABEL : 'Étapes dérivées du planning'}</p>}
        <p className="mt-2 flex items-center gap-1.5 text-xs text-text-muted"><Check className="size-3" /> Enregistrée dans Arete</p>
        <p role="status" aria-atomic="true" className={`mt-1 flex items-center gap-1.5 text-xs ${uncertain || state?.state === 'failed' ? 'text-warning-orange' : sent ? 'text-success-green' : 'text-text-secondary'}`}>
          {working ? <Loader2 className="size-3 motion-safe:animate-spin" /> : uncertain ? <CircleAlert className="size-3" /> : sent ? <Check className="size-3" /> : null}
          {pending && state?.state !== 'working' ? actions.pendingLabels.get(sessionId) : exportLabel(state)}
        </p>
      </div>
    </div>
    {session.reason && <p className="mt-2 text-xs text-warning-orange">{session.reason}</p>}
    {(readError || actions.error || state?.error) && <p role="alert" className="mt-2 text-xs text-danger-red">{actions.error ?? readError ?? state?.error}</p>}
    {session.prescription && <details className="mt-3 text-xs text-text-secondary">
      <summary className="flex cursor-pointer items-center gap-1"><ChevronDown className="size-3" /> Voir les étapes</summary>
      <StepList prescription={session.prescription} />
    </details>}
    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
      <button disabled={!canEdit} className="min-h-9 text-neon-cyan disabled:opacity-40" onClick={() => setEditing(true)}>{session.prescription && !session.needs_steps ? 'Modifier' : 'Compléter les étapes'}</button>
      {/* After reload, a durable working state may outlive its run; the server owns reservation expiry. */}
      {state && <button disabled={pending || locked} className="min-h-9 text-neon-cyan disabled:opacity-40" onClick={() => void actions.run({ kind: 'verify', session })}>Vérifier Garmin</button>}
      {!compact && <Link to={`/planning?date=${session.date}&session=${session.id}`} className="ml-auto inline-flex min-h-9 items-center gap-1 text-text-muted">Planning <ExternalLink className="size-3" /></Link>}
    </div>
    {editing && <EditWorkout key={session.revision} session={session} onClose={() => setEditing(false)} onResult={onResult} />}
  </div>;
}

const targetText = (target: Target) => target.kind === 'pace_sec_km'
  ? `${formatPace(target.low, "'")}–${formatPace(target.high, "'")}/km`
  : `${target.low}–${target.high} ${({ hr_zone: 'zone FC', heart_rate_bpm: 'bpm', power_w: 'W', cadence_rpm: 'tr/min' })[target.kind]}`;

export function StepList({ prescription }: { prescription: Prescription }) {
  const render = (steps: Prescription['steps'], depth: number): React.ReactNode => {
    if (depth > 2) return <li>Structure trop profonde.</li>;
    return steps.map((step, index) => <li key={index} className="my-1">
      {step.kind === 'repeat' ? <>{step.repeat} répétitions{step.skip_last_recovery && ' · sans la dernière récup'}<ul className="ml-4 border-l border-text-muted/20 pl-3">{render(step.steps, depth + 1)}</ul></> : <>
        {({ warmup: 'Échauffement', effort: 'Effort', recovery: 'Récupération', cooldown: 'Retour au calme', rest: 'Repos' })[step.kind]} · {step.exercise ? `${step.exercise} · ` : ''}
        {step.duration_kind === 'lap' ? 'Tour manuel' : step.duration_kind === 'seconds' && step.value ? formatClock(step.value) : `${step.value} ${({ seconds: 's', meters: 'm', reps: 'répétitions' })[step.duration_kind]}`}
        {step.target && ` · ${targetText(step.target)}`}
        {step.secondary_target && ` · ${targetText(step.secondary_target)}`}
        {step.weight_kg != null && ` · ${step.weight_kg} kg`}{step.stroke && ` · ${({ free: 'crawl', back: 'dos', breast: 'brasse', butterfly: 'papillon', mixed: 'quatre nages' })[step.stroke]}`}{step.notes && ` · ${step.notes}`}
      </>}
    </li>);
  };
  return <ol className="mt-2 space-y-1 border-l border-text-muted/20 pl-3 leading-relaxed">{render(prescription.steps, 0)}</ol>;
}
