import { useQuery } from '@tanstack/react-query';
import { documentRequest } from '@/lib/documents';
import { Modal, ModalHeader } from '@/components/ui';
import { readableError } from '@/lib/utils';

interface Activity {
  id: number;
  date: string;
  name: string | null;
  sport: string;
  duration_sec: number | null;
  distance_m: number | null;
  avg_hr: number | null;
  source: string;
}
export function RecordSource({ id, close }: { id: number; close: () => void }) {
  const activity = useQuery({
    queryKey: ['actual', 'detail', id],
    queryFn: () => documentRequest<Activity>(`/analytics/sessions/${id}`),
  });
  const a = activity.data;
  return (
    <Modal open onClose={close} label="Source du record">
      <ModalHeader title="Séance source" onClose={close} />
      {activity.isPending && <p role="status">Chargement…</p>}
      {activity.error && (
        <p role="alert" className="text-danger-red">
          {readableError(activity.error)}
        </p>
      )}
      {a && (
        <div className="space-y-4">
          <h3 className="text-lg font-bold">{a.name ?? a.sport}</h3>
          <p className="font-sans text-xs text-text-muted">
            {a.date} · {a.source} · activité #{a.id}
          </p>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-text-muted">Durée</dt>
              <dd>
                {a.duration_sec !== null
                  ? `${Math.round(a.duration_sec / 60)} min`
                  : 'Non mesurée'}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Distance</dt>
              <dd>
                {a.distance_m !== null
                  ? `${(a.distance_m / 1000).toFixed(2)} km`
                  : 'Non mesurée'}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Fréquence cardiaque moyenne</dt>
              <dd>{a.avg_hr !== null ? `${a.avg_hr} bpm` : 'Non mesurée'}</dd>
            </div>
          </dl>
          <p className="text-xs text-text-muted">
            Le record vient de l’effort mesuré de cette activité ; la durée
            totale ne permet pas de le reconstituer.
          </p>
        </div>
      )}
    </Modal>
  );
}
