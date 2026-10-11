import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Trophy } from 'lucide-react';
import { analyticsApi } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Sport groups the backend's /analytics/records accepts. */
const RECORD_SPORTS = [
  { value: 'running', label: 'COURSE' },
  { value: 'cycling', label: 'VÉLO' },
] as const;
type RecordSport = (typeof RECORD_SPORTS)[number]['value'];

/** All-time bests, independent of the selected period. */
export function RecordsCard({ onOpen }: { onOpen?: (id: number) => void } = {}) {
  const [sport, setSport] = useState<RecordSport>('running');
  const { data, isLoading, isError } = useQuery({
    queryKey: ['analytics', 'records', sport],
    queryFn: () => analyticsApi.getRecords(sport),
    staleTime: 5 * 60 * 1000,
  });
  const records = data?.records ?? [];

  return (
    <section className="bg-abyss rounded-lg border border-text-muted/20 p-4 flex flex-col gap-3">
      <header className="flex items-center gap-2">
        <Trophy className="w-4 h-4 text-neon-gold" aria-hidden />
        <h3 className="text-sm font-sans text-neon-cyan uppercase tracking-wider">Records</h3>
        <div className="flex gap-1 ml-auto" role="group" aria-label="Sport des records">
          {RECORD_SPORTS.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setSport(s.value)}
              aria-pressed={sport === s.value}
              className={cn(
                'px-2 py-0.5 text-[10px] font-sans rounded border transition-colors',
                sport === s.value
                  ? 'bg-neon-cyan/20 text-neon-cyan border-neon-cyan/50'
                  : 'bg-abyss text-text-secondary border-text-muted/30'
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </header>

      {isLoading ? (
        <p className="text-sm text-text-muted animate-pulse py-6 text-center">Chargement…</p>
      ) : isError ? (
        <p className="text-sm text-danger-red py-6 text-center">Données indisponibles</p>
      ) : records.length === 0 ? (
        <p className="text-sm text-text-muted py-6 text-center">
          Aucun record : les meilleurs efforts viennent des activités Strava.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-text-muted font-sans">
              <th className="text-left font-normal pb-1">Distance</th>
              <th className="text-right font-normal pb-1">Temps</th>
              <th className="text-right font-normal pb-1">Date</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.name} className="border-t border-text-muted/10">
                <td className="py-1.5 font-sans text-text-secondary">{r.name}</td>
                <td className="py-1.5 text-right font-sans text-text-primary tabular-nums">{onOpen && r.activity_id ? <button className="min-h-11 text-neon-cyan underline underline-offset-4" aria-label={`Voir la séance du record ${r.name}`} onClick={() => onOpen(r.activity_id!)}>{r.time_display}</button> : r.time_display}</td>
                <td className="py-1.5 text-right font-sans text-text-muted tabular-nums" title={r.activity_name}>
                  {new Date(`${r.date}T00:00:00`).toLocaleDateString('fr-FR', {
                    day: 'numeric',
                    month: 'short',
                    year: '2-digit',
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
