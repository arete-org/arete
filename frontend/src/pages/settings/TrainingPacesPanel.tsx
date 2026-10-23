import { useQuery } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';
import { Panel } from '@/components/ui';
import { metricsApi } from '@/lib/api';
import { qk } from '@/lib/queryKeys';
import { RACE_LABEL, formatRaceTime } from '@/lib/race';
import { formatPace } from '@/lib/utils';
import type { RaceKey, TrainingPaces } from '@/types';

const SOURCE_LABEL: Record<NonNullable<TrainingPaces['source']>, string> = {
  garmin_prediction: 'd’après les prédictions de course Garmin',
  threshold_pace: 'd’après ton allure au seuil',
};

function PaceCell({ letter, label, value }: { letter: string; label: string; value: string }) {
  return (
    <div className="rounded border border-text-muted/20 bg-abyss p-2">
      <p className="text-[11px] font-sans text-text-muted">
        <span className="text-neon-cyan mr-1">{letter}</span>
        {label}
      </p>
      <p className="text-sm font-sans text-text-primary">{value}</p>
    </div>
  );
}

/** Daniels training paces from the current VDOT; read-only. */
export function TrainingPacesPanel() {
  const { data, isLoading, isError } = useQuery({ queryKey: qk.paces, queryFn: metricsApi.getPaces });
  const paces = data?.paces;
  const equivalents = data?.equivalents;

  return (
    <Panel
      level={3}
      variant="inset"
      title={
        <span className="flex items-center gap-2">
          <Gauge className="size-4 text-neon-cyan" /> Allures d’entraînement
        </span>
      }
    >
      {isLoading && <p className="text-sm text-text-muted">Calcul des allures…</p>}
      {isError && <p className="text-sm text-danger-red">Allures indisponibles.</p>}
      {data && !paces && <p className="text-sm text-text-muted">{data.reason}</p>}
      {data && paces && (
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            VDOT <span className="font-sans text-neon-cyan">{paces.vdot.toLocaleString('fr-FR')}</span>
            {data.source && <span className="text-xs text-text-muted"> · {SOURCE_LABEL[data.source]}</span>}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <PaceCell
              letter="E"
              label="Endurance"
              value={`${formatPace(paces.easy[0])}–${formatPace(paces.easy[1])}/km`}
            />
            <PaceCell letter="M" label="Marathon" value={`${formatPace(paces.marathon)}/km`} />
            <PaceCell letter="T" label="Seuil" value={`${formatPace(paces.threshold)}/km`} />
            <PaceCell letter="I" label="Intervalles" value={`${formatPace(paces.interval)}/km`} />
            <PaceCell letter="R" label="Répétitions" value={`${formatPace(paces.repetition)}/km`} />
          </div>
          {equivalents && (
            <div>
              <p className="text-xs font-sans text-text-muted mb-1">Équivalences de course</p>
              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-sm">
                {(Object.keys(RACE_LABEL) as RaceKey[]).map((key) => (
                  <div key={key} className="flex justify-between gap-2">
                    <dt className="text-text-muted">{RACE_LABEL[key]}</dt>
                    <dd className="font-sans text-text-primary">{formatRaceTime(equivalents[key])}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          <p className="text-xs text-text-muted">
            Une allure au seuil modifiée ci-dessus compte une fois les réglages enregistrés.
          </p>
        </div>
      )}
    </Panel>
  );
}
