import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import { Send, Watch, X } from 'lucide-react';
import { exportApi } from '@/lib/documents';
import { useWorkoutActions } from '@/hooks/useWorkoutActions';
import { type WorkoutSession, type WorkoutView, workoutApi, workoutKey, workoutsKey, mergeWorkout, readWorkouts } from '@/lib/workouts';
import { WorkoutCard } from './WorkoutCard';
import { readableError } from '@/lib/utils';

const CARD_STALE_MS = 60_000;
const POLL_MS = 1000;
const MAX_POLL_MS = 150_000;

/** Selection is local; cards and direct API mutations are shared by chat and Planning. */
export function WorkoutSelection({ sessions, children, onResult, locked = false, renderWorkout }: {
  renderWorkout?: (props: ComponentProps<typeof WorkoutCard>) => ReactNode;
  sessions: WorkoutView[]; children?: (render: (id: number) => ReactNode) => ReactNode;
  onResult?: (text: string) => void; locked?: boolean;
}) {
  const [selected, setSelected] = useState<Map<number, WorkoutSession>>(new Map());
  const [watch, setWatch] = useState(false);
  const [deviceId, setDeviceId] = useState<number | null>(null);
  const [completed, setCompleted] = useState('');
  const actions = useWorkoutActions(text => { setCompleted(text); onResult?.(text); });
  const devices = useQuery({ queryKey: ['garmin-workout-devices'], queryFn: exportApi.devices, enabled: watch, retry: false });
  const views = useQueries({ queries: sessions.map(v => ({ queryKey: workoutKey(v.session.id), queryFn: () => workoutApi.inspect(v.session.id), enabled: false })) });
  const latest = sessions.map((v, i) => mergeWorkout(views[i].data, v));
  // Planning draws its own cards from /garmin/exports. Workout cards read the
  // server's view of every session in one request, then poll only those in progress.
  const queryClient = useQueryClient();
  const cards = !renderWorkout;
  const ids = sessions.map(v => v.session.id);
  const read = useQuery({
    queryKey: workoutsKey('cards', ids), queryFn: () => readWorkouts(queryClient, ids),
    enabled: cards && ids.length > 0, staleTime: CARD_STALE_MS, retry: false,
  });
  const inProgress = cards ? latest.filter(v => actions.pendingIds.has(v.session.id) || v.export?.state === 'working').map(v => v.session.id) : [];
  const pollStarted = useRef<number | null>(null);
  useEffect(() => { if (!inProgress.length) pollStarted.current = null; }, [inProgress.length]);
  useQuery({
    queryKey: workoutsKey('progress', inProgress), queryFn: () => readWorkouts(queryClient, inProgress),
    enabled: inProgress.length > 0, retry: false,
    refetchInterval: () => {
      pollStarted.current ??= Date.now();
      return Date.now() - pollStarted.current < MAX_POLL_MS ? POLL_MS : false;
    },
  });
  const scheduled = latest.filter(v => ['scheduled', 'transfer_requested'].includes(v.export?.state ?? '')).length;
  const working = latest.some(v => v.export?.state === 'working');
  const visible = new Set(sessions.map(v => v.session.id));
  const effective = [...selected.values()].filter(s => visible.has(s.id));
  const selectionBlocked = effective.some(s => {
    const current = latest.find(v => v.session.id === s.id);
    return !current || current.session.revision !== s.revision || current.session.exportable === false || ['working', 'uncertain', 'conflict'].includes(current.export?.state ?? '');
  });
  const render = (id: number) => {
    const props: ComponentProps<typeof WorkoutCard> = {
      sessionId: id, initial: latest.find(v => v.session.id === id), compact: !!children,
      readError: (read.error ? readableError(read.error) : read.data?.errors[id]),
      selected: selected.has(id), locked,
      onResult: text => { setCompleted(text); onResult?.(text); },
      onSelect: (session, checked) => {
        if (checked && selected.size >= 50) { setCompleted('Maximum 50 séances par envoi.'); return; }
        setSelected(previous => {
          const next = new Map(previous);
          if (checked) next.set(session.id, session); else next.delete(session.id);
          return next;
        });
        setCompleted('');
      },
    };
    return renderWorkout ? renderWorkout(props) : <WorkoutCard key={id} {...props} />;
  };
  const send = async () => {
    if (await actions.run({ kind: 'export', sessions: effective, deviceId: watch ? deviceId : null })) setSelected(new Map());
  };
  return <div aria-label="Séances et Garmin Connect">
    {(working || (scheduled > 0 && !children)) && <p role="status" className="my-2 text-xs text-text-secondary tabular-nums">{scheduled} séance{scheduled > 1 ? 's' : ''} sur {sessions.length} programmée{scheduled > 1 ? 's' : ''}{working ? ' · envoi en cours' : ''}</p>}
    {(effective.length > 0) && <div className={`sticky ${children ? 'top-16' : 'top-0'} z-10 my-3 rounded-xl border border-text-muted/20 bg-abyss p-3 shadow-lg`} style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-medium tabular-nums">{effective.length} séance{effective.length > 1 ? 's' : ''} sélectionnée{effective.length > 1 ? 's' : ''}</span>
        <button disabled={actions.busy || locked || selectionBlocked || !effective.length || (watch && !deviceId)} onClick={() => void send()} className="flex min-h-11 items-center gap-2 rounded-lg bg-neon-cyan/15 px-4 text-sm font-medium text-neon-cyan transition-colors duration-150 disabled:opacity-40">
          <Send className="size-4" />{actions.busy ? 'Envoi en cours…' : 'Envoyer vers Garmin'}
        </button>
      </div>
      <label className="mt-2 flex min-h-9 items-center gap-2 text-xs text-text-secondary"><input type="checkbox" checked={watch} disabled={actions.busy || locked} onChange={e => { setWatch(e.target.checked); setDeviceId(null); }} /><Watch className="size-3.5" /> Demander aussi le transfert vers une montre</label>
      {watch && <><select aria-label="Montre Garmin" className="mt-1 w-full rounded-lg border border-text-muted/25 bg-void p-2 text-sm" value={deviceId ?? ''} disabled={actions.busy} onChange={e => setDeviceId(Number(e.target.value) || null)}>
        <option value="">Choisir une montre compatible</option>{devices.data?.map(d => <option key={d.id} value={d.id} disabled={!effective.every(s => d.sports.includes(s.sport))}>{d.name}{!d.sports.length ? ' · compatibilité inconnue' : ''}</option>)}
      </select><p className="mt-1 text-xs text-text-muted">La réception se vérifie sur la montre après synchronisation.</p></>}
      {selectionBlocked && !actions.busy && <p className="mt-2 text-xs text-warning-orange">Une séance a changé ou nécessite une vérification Garmin. Vérifie son état, puis sélectionne-la à nouveau.</p>}
      {devices.error && watch && <p role="alert" className="mt-2 text-xs text-danger-red">{readableError(devices.error)} Tu peux envoyer vers Connect sans montre.</p>}
      {actions.error ? <p role="alert" className="mt-2 text-xs text-danger-red">{actions.error}</p> : completed && <p role="status" className="mt-2 text-xs text-text-secondary">{completed}</p>}
    </div>}
    {!effective.length && completed && <div role="status" className="my-3 flex items-start gap-3 rounded-xl border border-text-muted/15 bg-shadow/30 p-3 text-xs text-text-secondary">
      <p className="flex-1">{completed}</p><button aria-label="Masquer le résultat" onClick={() => setCompleted('')} className="-m-2 flex size-9 shrink-0 items-center justify-center"><X className="size-3.5" /></button>
    </div>}
    {children ? children(render) : sessions.map(s => render(s.session.id))}
  </div>;
}
