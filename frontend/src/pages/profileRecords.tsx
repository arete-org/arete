import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { documentRequest } from '@/lib/documents';
import { Select } from '@/components/ui';

interface Exercise {
  id: number;
  name: string;
}
interface Records {
  max_weight: number | null;
  max_weight_reps: number | null;
  max_weight_date: string | null;
  estimated_1rm: number | null;
  max_session_volume: number | null;
  max_volume_date: string | null;
}

export function StrengthRecords() {
  const [id, setId] = useState('');
  const exercises = useQuery({
    queryKey: ['exercises'],
    queryFn: () => documentRequest<Exercise[]>('/strength/exercises'),
  });
  const records = useQuery({
    queryKey: ['strengthRecords', id],
    queryFn: () => documentRequest<Records>(`/strength/exercises/${id}/prs`),
    enabled: !!id,
  });
  const r = records.data;
  return (
    <section className="border-t border-text-muted/20 pt-5 space-y-4">
      <h2 className="font-bold">Records de force</h2>
      <label className="block text-xs text-text-muted">
        Exercice
        <Select
          value={id}
          onChange={(e) => setId(e.target.value)}
          className="block mt-2 min-h-11 text-sm"
        >
          <option value="">Choisir un exercice</option>
          {exercises.data?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
      </label>
      {(exercises.error || records.error) && (
        <p role="alert" className="text-danger-red text-sm">
          Records indisponibles.
        </p>
      )}
      {records.isFetching && (
        <p role="status" className="text-text-muted text-sm">
          Chargement…
        </p>
      )}
      {r && (
        <dl className="font-sans text-sm space-y-3">
          <div>
            <dt className="text-text-muted text-xs">Série réalisée</dt>
            <dd>
              {r.max_weight !== null
                ? `${r.max_weight} kg × ${r.max_weight_reps} répétitions · ${r.max_weight_date}`
                : 'Non mesurée'}
            </dd>
          </div>
          <div>
            <dt className="text-text-muted text-xs">
              1RM estimé (distinct d’un record réalisé)
            </dt>
            <dd>
              {r.estimated_1rm !== null
                ? `${r.estimated_1rm} kg`
                : 'Non mesuré'}
            </dd>
          </div>
          <div>
            <dt className="text-text-muted text-xs">
              Volume maximal d’une séance
            </dt>
            <dd>
              {r.max_session_volume !== null
                ? `${r.max_session_volume} kg · ${r.max_volume_date}`
                : 'Non mesuré'}
            </dd>
          </div>
        </dl>
      )}
      {id && (
        <Link
          to={`/log?exercise=${id}`}
          className="inline-block font-sans text-xs text-neon-cyan"
        >
          Voir la progression →
        </Link>
      )}
    </section>
  );
}
