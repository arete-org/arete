import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState } from '@/components';
import { Button, Panel } from '@/components/ui';
import { adminApi, KPI_KEYS, type KpiWeek } from '@/lib/api';
import { downloadKpisCsv, KPI_LABELS, kpiCounts, kpiValue, weekLabel } from '@/lib/productKpis';
import { qk } from '@/lib/queryKeys';

const WEEKS = 12;

const weekName = (week: KpiWeek) => `${weekLabel(week)}${week.current ? ' (en cours)' : ''}`;

/** The current week's figures, one tile per indicator. */
function CurrentWeek({ week }: { week: KpiWeek }) {
  return (
    <ul aria-label="Semaine en cours" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {KPI_KEYS.map((key) => (
        <li key={key} className="rounded border border-text-muted/20 p-3">
          <div className="text-[11px] font-sans uppercase tracking-wider text-text-muted">{KPI_LABELS[key].label}</div>
          <div className="mt-1 text-2xl font-sans font-semibold tabular-nums text-text-primary">
            {kpiValue(key, week.indicators[key])}
          </div>
          <div className="text-[11px] tabular-nums text-text-muted">{kpiCounts(key, week.indicators[key])}</div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Product indicators per ISO week, counted by the server across athletes: no
 * athlete is named. A table on desktop, one card per week on mobile.
 */
export function ProductKpisPanel() {
  const kpis = useQuery({ queryKey: qk.adminKpis(WEEKS), queryFn: () => adminApi.kpis(WEEKS), retry: false });
  const weeks = kpis.data ?? [];

  return (
    <Panel variant="inset" className="space-y-4">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <h2 className="text-lg font-sans text-text-primary">Indicateurs produit</h2>
        <Button
          variant="outline"
          size="sm"
          disabled={weeks.length === 0}
          onClick={() => downloadKpisCsv(weeks)}
          className="text-text-secondary hover:border-neon-cyan/50 hover:text-neon-cyan"
        >
          <Download className="w-3 h-3" />
          Exporter en CSV
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        Par semaine ISO, du lundi au dimanche, sur les athlètes actifs. Seuls des totaux sont lus : aucune donnée
        personnelle. La rétention et le délai avant la 1re action ne comptent que les inscriptions : les comptes
        repris lors du passage au multi-athlètes, dont celui du propriétaire, en sont exclus.
      </p>

      {kpis.isPending ? (
        <LoadingState message="Chargement des indicateurs…" />
      ) : kpis.isError ? (
        <ErrorState message="Indicateurs indisponibles" onRetry={() => void kpis.refetch()} />
      ) : weeks.length === 0 ? (
        <EmptyState message="Aucun indicateur" />
      ) : (
        <>
          <CurrentWeek week={weeks[0]} />

          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Indicateurs des {weeks.length} dernières semaines</caption>
              <thead>
                <tr className="font-sans text-[11px] tracking-wider text-text-muted align-bottom">
                  <th scope="col" className="pb-2 pr-4 font-normal whitespace-nowrap">
                    SEMAINE DU
                  </th>
                  {KPI_KEYS.map((key) => (
                    <th key={key} scope="col" className="pb-2 pr-4 font-normal min-w-[7rem]">
                      <abbr title={KPI_LABELS[key].detail} className="no-underline">
                        {KPI_LABELS[key].label}
                      </abbr>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weeks.map((week) => (
                  <tr key={week.week_start} className="border-t border-text-muted/10 align-top">
                    <th scope="row" className="py-2 pr-4 font-normal whitespace-nowrap text-text-secondary">
                      {weekName(week)}
                    </th>
                    {KPI_KEYS.map((key) => (
                      <td key={key} className="py-2 pr-4 tabular-nums">
                        <div className="text-text-primary">{kpiValue(key, week.indicators[key])}</div>
                        <div className="text-[11px] text-text-muted">{kpiCounts(key, week.indicators[key])}</div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul aria-label="Semaines" className="md:hidden space-y-3">
            {weeks.map((week) => (
              <li key={week.week_start} className="rounded border border-text-muted/20 p-3">
                <h3 className="text-sm font-sans text-text-secondary">Semaine du {weekName(week)}</h3>
                <dl className="mt-2 space-y-1 text-xs">
                  {KPI_KEYS.map((key) => (
                    <div key={key} className="flex justify-between gap-3">
                      <dt className="text-text-muted">{KPI_LABELS[key].label}</dt>
                      <dd className="tabular-nums text-right text-text-primary">
                        {kpiValue(key, week.indicators[key])}{' '}
                        <span className="text-text-muted">({kpiCounts(key, week.indicators[key])})</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
