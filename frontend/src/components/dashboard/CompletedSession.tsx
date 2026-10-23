import { Link } from 'react-router-dom';
import { RpePicker } from '@/components/RpePicker';
import { formatDecimal } from '@/lib/fr';
import { formatDurationCompact } from '@/lib/utils';
import type { ActualSession } from '@/types';

/** A readable daily row; full activity data stays in its existing journal detail. */
export function CompletedSession({ session, offPlan = false }: { session: ActualSession; offPlan?: boolean }) {
  const km = session.distance_km ?? (session.distance_m != null ? session.distance_m / 1000 : null);
  return <div className="border-b border-border py-3 last:border-b-0">
    <Link to={session.id < 0 ? `/log?session=${-session.id}` : `/log/sessions/${session.id}`} className="block min-h-11 rounded-[var(--radius-control)] hover:text-neon-cyan">
      <p className="text-[15px] font-medium leading-relaxed">{session.name || (session.sport === 'strength' ? 'Muscu' : 'Séance')}
        {session.duration_sec > 0 && <> · {formatDurationCompact(session.duration_sec)}</>}
        {km != null && km > 0 && <> · {formatDecimal(km, 1)} km</>}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-text-muted">Terminée{offPlan ? ' · hors plan' : ' · prévue'}{session.rpe != null ? ` · RPE ${session.rpe}/10` : ''}</p>
      {!!session.exercises?.length && <p className="mt-1 text-xs leading-relaxed text-text-secondary">{session.exercises.join(' · ')}</p>}
    </Link>
    {session.id > 0 && session.rpe == null && <RpePicker sessionId={session.id} className="mt-2" />}
  </div>;
}
