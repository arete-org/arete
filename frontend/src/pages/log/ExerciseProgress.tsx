import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Panel } from '@/components/ui';
import { strengthApi } from '@/lib/api';
import { parseLocalDate } from '@/lib/dates';
import { qk } from '@/lib/queryKeys';
import { formatKg, recordTitle, recordValue } from '@/lib/strengthProgress';
import { SuggestionNote } from './progression';

// recharts stays out of the Log bundle until a trend is drawn.
const E1rmChart = lazy(() => import('./E1rmChart').then((m) => ({ default: m.E1rmChart })));

const shortDate = (iso: string) =>
  parseLocalDate(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

/**
 * One exercise over time: e1RM trend, records and the next-session load.
 * Reads /history, /prs and /suggestion; warm-ups count in none of them.
 */
export function ExerciseProgress({
  exerciseId,
  onSelect,
}: {
  exerciseId: number | null;
  onSelect: (id: number | null) => void;
}) {
  const exercises = useQuery({ queryKey: qk.exercises, queryFn: strengthApi.getExercises });
  const enabled = exerciseId !== null;
  const id = exerciseId ?? 0;
  const history = useQuery({
    queryKey: qk.strengthProgress(id, 'history'),
    queryFn: () => strengthApi.getExerciseHistory(id),
    enabled,
  });
  const records = useQuery({
    queryKey: qk.strengthProgress(id, 'records'),
    queryFn: () => strengthApi.getExerciseRecords(id),
    enabled,
  });
  const suggestion = useQuery({
    queryKey: qk.strengthProgress(id, 'suggestion'),
    queryFn: () => strengthApi.getExerciseSuggestion(id),
    enabled,
  });

  // /history is newest first; the chart reads left to right.
  const points = [...(history.data ?? [])]
    .reverse()
    .filter((h) => h.best_e1rm != null)
    .map((h) => ({ date: h.date, e1rm: h.best_e1rm }));
  const r = records.data;
  const failed = exercises.error || history.error || records.error || suggestion.error;

  return (
    <Panel title="PROGRESSION PAR EXERCICE" delay={0.2}>
      <label className="block text-xs font-sans text-text-muted">
        Exercice
        <select
          value={exerciseId ?? ''}
          onChange={(e) => onSelect(e.target.value ? Number(e.target.value) : null)}
          className="block mt-2 min-h-11 w-full rounded border border-text-muted/30 bg-abyss px-3 text-sm text-text-primary"
        >
          <option value="">Choisir un exercice</option>
          {exercises.data?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>

      {failed && (
        <p role="alert" className="mt-3 text-sm font-sans text-danger-red">
          Progression indisponible.
        </p>
      )}

      {enabled && history.isSuccess && (
        <div className="mt-4">
          <h4 className="text-[11px] font-sans text-text-muted uppercase mb-2">1RM estimé (Epley)</h4>
          {points.length > 1 ? (
            <Suspense fallback={<div className="h-[180px]" />}>
              <E1rmChart points={points} />
            </Suspense>
          ) : (
            <p className="text-xs font-sans text-text-muted">
              {points.length === 1
                ? `Une seule séance chargée : ${formatKg(points[0].e1rm)}.`
                : 'Pas de série chargée de 1 à 12 répétitions.'}
            </p>
          )}
        </div>
      )}

      {enabled && suggestion.data?.suggestion && (
        <SuggestionNote suggestion={suggestion.data.suggestion} label="Prochaine séance" />
      )}

      {enabled && r && (
        <dl className="mt-4 space-y-2 font-sans text-sm">
          <div>
            <dt className="text-[11px] text-text-muted">Charge la plus lourde</dt>
            <dd>
              {r.max_weight != null
                ? `${formatKg(r.max_weight)} × ${r.max_weight_reps} · ${shortDate(r.max_weight_date ?? '')}`
                : 'Non mesurée'}
            </dd>
          </div>
          {r.best_e1rm && (
            <div>
              <dt className="text-[11px] text-text-muted">{recordTitle(r.best_e1rm)}</dt>
              <dd>
                {recordValue(r.best_e1rm)}
                {r.best_e1rm.date && ` · ${shortDate(r.best_e1rm.date)}`}
              </dd>
            </div>
          )}
          {r.rep_records.length > 0 && (
            <div>
              <dt className="text-[11px] text-text-muted">Meilleures séries par charge</dt>
              {r.rep_records.map((rec) => (
                <dd key={`${rec.weight_kg}`}>
                  {formatKg(rec.weight_kg)} × {rec.reps}
                  {rec.date && ` · ${shortDate(rec.date)}`}
                </dd>
              ))}
            </div>
          )}
        </dl>
      )}
    </Panel>
  );
}
