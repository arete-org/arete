import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { ArrowLeft, Award, Flame, Mountain, Route, Timer } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState } from '@/components';
import { Select } from '@/components/ui';
import { COLORS } from '@/lib/chartTheme';
import { sportLabel } from '@/lib/fr';
import { qk } from '@/lib/queryKeys';
import { getSportHex } from '@/lib/sport';
import { cn } from '@/lib/utils';
import { yearReviewApi, type YearMonth, type YearReview, type YearSession } from '@/lib/yearReview';
import { AXIS, ChartGrid, ChartTooltip, TICK } from './analytics/chartParts';

const NUMBER = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const DECIMAL = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

const km = (m: number | null | undefined) => `${DECIMAL.format((m ?? 0) / 1000)} km`;
const hours = (sec: number) => `${NUMBER.format(sec / 3600)} h`;
const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
const monthLabel = (m: number) => new Date(2000, m - 1, 1).toLocaleDateString('fr-FR', { month: 'short' });

/** "1h05" or "42 min" for a single session. */
function duration(sec: number): string {
  const minutes = Math.round(sec / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
}

/** "−12 s" / "−1:05" improvement on the previous best. */
function gain(previous: number, now: number): string {
  const s = previous - now;
  return s >= 60 ? `−${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `−${s} s`;
}

const METRICS = [
  { id: 'duration', label: 'Temps', value: (m: YearMonth) => m.duration_sec / 3600, unit: 'h' },
  { id: 'distance', label: 'Distance', value: (m: YearMonth) => m.distance_m / 1000, unit: 'km' },
  { id: 'sessions', label: 'Séances', value: (m: YearMonth) => m.sessions, unit: '' },
  { id: 'strength', label: 'Force', value: (m: YearMonth) => m.strength_volume_kg / 1000, unit: 't' },
] as const;

type MetricId = (typeof METRICS)[number]['id'];

function Block({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('analysis-card space-y-4 min-w-0', className)}>
      <h2 className="text-[15px] font-medium text-text-primary">{title}</h2>
      {children}
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="analysis-card min-w-0">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="text-2xl sm:text-[32px] font-semibold text-text-primary tabular-nums break-words">{value}</div>
    </div>
  );
}

function MonthsChart({ months }: { months: YearMonth[] }) {
  const [params, setParams] = useSearchParams();
  const metricId: MetricId = METRICS.find(item => item.id === params.get('metric'))?.id ?? 'duration';
  const setMetricId = (id: MetricId) => setParams(previous => {
    const next = new URLSearchParams(previous);
    next.set('metric', id);
    return next;
  });
  const metric = METRICS.find((m) => m.id === metricId) ?? METRICS[0];
  const data = months.map((m) => ({ month: monthLabel(m.month), value: Number(metric.value(m).toFixed(1)) }));
  return (
    <Block title="Mois par mois">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Mesure">
        {METRICS.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-pressed={m.id === metricId}
            onClick={() => setMetricId(m.id)}
            className="analysis-tab"
          >
            {m.label}
          </button>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={256}>
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -16 }}>
          <ChartGrid />
          <XAxis dataKey="month" {...AXIS} tick={TICK} interval={0} tickFormatter={(v: string) => v.slice(0, 3)} />
          <YAxis {...AXIS} tick={TICK} width={44} />
          <ChartTooltip formatter={(value: number) => [`${DECIMAL.format(value)} ${metric.unit}`.trim(), metric.label]} />
          <Bar isAnimationActive={false} dataKey="value" name={metric.label} fill={COLORS.neonCyan} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </Block>
  );
}

function FitnessChart({ fitness }: { fitness: YearReview['fitness'] }) {
  if (!fitness.series.length) return <p className="text-sm text-text-muted">Pas de charge enregistrée.</p>;
  return (
    <>
      <p className="text-sm text-text-secondary">
        {fitness.peak && (
          <>
            Pic de forme à <strong className="text-text-primary">{DECIMAL.format(fitness.peak.ctl)}</strong> le{' '}
            {longDate(fitness.peak.date)}.{' '}
          </>
        )}
        De {DECIMAL.format(fitness.start_ctl ?? 0)} à {DECIMAL.format(fitness.end_ctl ?? 0)} sur la période.
      </p>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={fitness.series} margin={{ top: 8, right: 4, bottom: 0, left: -16 }}>
          <ChartGrid />
          <XAxis
            dataKey="date"
            {...AXIS}
            tick={TICK}
            minTickGap={28}
            tickFormatter={(iso: string) => monthLabel(Number(iso.slice(5, 7)))}
          />
          <YAxis {...AXIS} tick={TICK} width={44} />
          <ChartTooltip labelFormatter={(iso: string) => longDate(iso)} formatter={(v: number) => [DECIMAL.format(v), 'Forme (CTL)']} />
          <Line isAnimationActive={false} type="monotone" dataKey="ctl" name="Forme" stroke={COLORS.neonCyan} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}

function Highlight({ icon, label, session, value }: { icon: ReactNode; label: string; session: YearSession | null; value: (s: YearSession) => string }) {
  return (
    <div className="flex items-start gap-3 p-3 rounded border border-text-muted/20 min-w-0">
      <span className="text-neon-gold mt-0.5">{icon}</span>
      <div className="min-w-0">
        <div className="text-xs text-text-muted">{label}</div>
        {session ? (
          <>
            <div className="text-base font-sans text-text-primary tabular-nums">{value(session)}</div>
            <div className="text-xs text-text-muted">
              {session.id !== null ? <Link className="inline-flex min-h-11 items-center underline" to={session.id! < 0 ? `/log?session=${-session.id!}` : `/log/sessions/${session.id}`}>{session.name || sportLabel(session.sport)} · {longDate(session.date)}</Link> : <>{session.name || sportLabel(session.sport)} · {longDate(session.date)}</>}
            </div>
          </>
        ) : (
          <div className="text-sm text-text-muted">—</div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="font-sans text-text-primary tabular-nums">{value}</span>
    </div>
  );
}

function Review({ data }: { data: YearReview }) {
  const { totals, consistency, highlights, strength } = data;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Tile label="Séances" value={NUMBER.format(totals.sessions)} />
        <Tile label="Temps" value={hours(totals.duration_sec)} />
        <Tile label="Distance" value={km(totals.distance_m)} />
        <Tile label="Dénivelé" value={`${NUMBER.format(totals.ascent_m)} m`} />
        <Tile label="Jours actifs" value={`${consistency.active_days} / ${consistency.days}`} />
      </div>

      <MonthsChart months={data.months} />

      <div className="analysis-grid">
        <Block title="Sports">
          <ul className="space-y-2">
            {data.sports.map((s) => (
              <li key={s.sport} className="space-y-1">
                <div className="flex justify-between gap-3 text-xs font-sans">
                  <span className="text-text-secondary truncate">{sportLabel(s.sport)}</span>
                  <span className="text-text-primary tabular-nums shrink-0">
                    {hours(s.duration_sec)} · {s.sessions} séance{s.sessions > 1 ? 's' : ''}
                    {s.distance_m > 0 && ` · ${km(s.distance_m)}`}
                  </span>
                </div>
                <div className="h-2 rounded bg-shadow overflow-hidden">
                  <div className="h-full rounded" style={{ width: `${s.pct_time}%`, backgroundColor: getSportHex(s.sport) }} />
                </div>
              </li>
            ))}
          </ul>
        </Block>

        <Block title="Régularité">
          <Stat label="Semaines actives" value={`${consistency.active_weeks} / ${consistency.weeks}`} />
          <Stat label="Plus longue série de jours" value={`${consistency.longest_day_streak} j`} />
          <Stat label="Plus longue série de semaines" value={`${consistency.longest_week_streak} sem.`} />
          <Stat label="Charge totale" value={`${NUMBER.format(totals.tss)} TSS`} />
        </Block>
      </div>

      <Block title="Forme (CTL)">
        <FitnessChart fitness={data.fitness} />
      </Block>

      <Block title="Temps forts">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Highlight icon={<Route className="w-4 h-4" />} label="Plus longue distance" session={highlights.longest_distance} value={(s) => km(s.distance_m)} />
          <Highlight icon={<Timer className="w-4 h-4" />} label="Plus longue durée" session={highlights.longest_duration} value={(s) => duration(s.duration_sec)} />
          <Highlight icon={<Flame className="w-4 h-4" />} label="La plus dure" session={highlights.hardest} value={(s) => `${s.tss} TSS`} />
          <Highlight icon={<Mountain className="w-4 h-4" />} label="Plus gros dénivelé" session={highlights.biggest_climb} value={(s) => `${NUMBER.format(s.ascent_m ?? 0)} m D+`} />
        </div>
      </Block>

      <div className="analysis-grid">
        <Block title={`Meilleurs efforts · ${data.pr_count} record${data.pr_count > 1 ? 's' : ''}`}>
          {data.best_efforts.length === 0 ? (
            <p className="text-sm text-text-muted">Aucun effort chronométré en course.</p>
          ) : (
            <ul className="divide-y divide-text-muted/10">
              {data.best_efforts.map((e) => (
                <li key={e.name} className="py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-sans text-text-primary">{e.name}</div>
                    <div className="text-xs text-text-muted truncate">
                      {e.activity_name || 'Course'} · {longDate(e.date)}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-sans text-text-primary tabular-nums">{e.time_display}</div>
                    {e.is_pr && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-sans uppercase text-neon-gold">
                        <Award className="w-3 h-3" aria-hidden />
                        {e.previous_best_sec === null ? 'Premier chrono' : `Record ${gain(e.previous_best_sec, e.time_sec)}`}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Block>

        <Block title="Force">
          {strength.sessions === 0 ? (
            <p className="text-sm text-text-muted">Aucune séance de force enregistrée.</p>
          ) : (
            <>
              <Stat label="Tonnage (séries de travail)" value={`${DECIMAL.format(strength.volume_kg / 1000)} t`} />
              <Stat label="Séances" value={NUMBER.format(strength.sessions)} />
              <Stat label="Séries" value={NUMBER.format(strength.working_sets)} />
              {strength.top_exercises.length > 0 && (
                <ul className="pt-2 space-y-1">
                  {strength.top_exercises.map((x) => (
                    <li key={x.name} className="flex justify-between gap-3 text-xs font-sans">
                      <span className="text-text-secondary truncate">{x.name}</span>
                      <span className="text-text-primary tabular-nums shrink-0">
                        {DECIMAL.format(x.volume_kg / 1000)} t{x.max_weight_kg ? ` · max ${DECIMAL.format(x.max_weight_kg)} kg` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Block>
      </div>
    </div>
  );
}

/** The year in numbers (Rundown / Year in Sport), computed by the server without a model. */
export function YearReviewPage() {
  const [params, setParams] = useSearchParams();
  const current = new Date().getFullYear();
  const requested = Number(params.get('year'));
  const year = Number.isInteger(requested) && requested >= 2000 && requested <= current ? requested : current;

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: qk.yearReview(year),
    queryFn: () => yearReviewApi.get(year),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="page-shell analytics-page">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link to="/analytics" className="inline-flex min-h-11 items-center gap-1 text-sm text-text-muted hover:text-neon-cyan">
            <ArrowLeft className="w-3 h-3" aria-hidden />
            Analyses
          </Link>
          <p className="page-eyebrow">Ton année en mouvement</p>
          <h1 className="page-title">Bilan {year}</h1>
          {data && (
            <p className="text-xs text-text-muted font-sans mt-1">
              Du {longDate(data.start)} au {longDate(data.end)}
              {!data.complete && ' · année en cours'}
            </p>
          )}
        </div>
        <Select
          aria-label="Année"
          className="w-28"
          value={year}
          onChange={(e) => setParams(previous => { const next = new URLSearchParams(previous); next.set('year', e.target.value); return next; })}
        >
          {(data?.years ?? [year]).map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </Select>
      </header>

      {isLoading ? (
        <LoadingState message="CALCUL DU BILAN…" />
      ) : isError || !data ? (
        <ErrorState message="BILAN INDISPONIBLE" onRetry={() => refetch()} />
      ) : data.totals.sessions === 0 ? (
        <EmptyState message={`AUCUNE SÉANCE EN ${year}`} action="Synchronise Garmin ou importe un fichier FIT, ou choisis une autre année." />
      ) : (
        <Review data={data} />
      )}
    </div>
  );
}
