import { createElement, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Dumbbell, Sparkles } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState } from '@/components';
import { GlossaryLink } from '@/components/GlossaryLink';
import { RpePicker } from '@/components/RpePicker';
import { Button, Modal, ModalHeader, Panel, RpeBadge } from '@/components/ui';
import { analyticsApi, strengthApi } from '@/lib/api';
import { chartRows, formatElapsed, intensityLabel, isFootSport } from '@/lib/activity';
import { CHART, COLORS, HR_ZONE_COLORS } from '@/lib/chartTheme';
import { parseLocalDate } from '@/lib/dates';
import { sportLabel } from '@/lib/fr';
import { glossaryHref, type GlossaryId } from '@/lib/glossary';
import { qk } from '@/lib/queryKeys';
import { getSportColor, getSportIconComponent } from '@/lib/sport';
import { cn, formatDurationCompact, formatPace, readableError } from '@/lib/utils';
import type {
  ActivityDetail,
  ActivityIntervals,
  ActivityLap,
  ActivityMetrics,
  ActivitySplit,
  ActivityTerrain,
  ActivityWeather,
} from '@/types';
import { StrengthExercises } from './log/StrengthExercises';
import { SameDayLogWarning } from './log/SameDayLogWarning';
import { useOpenDraft } from './log/useOpenDraft';
import { RouteTrace } from './session/RouteTrace';
import { StreamChart } from './session/StreamChart';
import { useCoachName } from '@/lib/coachName';

const ZONE_NAME = ['Z1 récupération', 'Z2 endurance', 'Z3 tempo', 'Z4 seuil', 'Z5 VO2max'];
const SOURCE_LABEL: Record<string, string> = {
  garmin_connect: 'Garmin',
  fit_file: 'Fichier FIT',
  strava: 'Strava',
  manual: 'Saisie manuelle',
};

const km = (m: number | null | undefined) => (m ? `${(m / 1000).toFixed(2)} km` : '—');
const pace = (sec: number | null | undefined) => (sec ? `${formatPace(sec)} /km` : '—');
const pct = (v: number) => `${v > 0 ? '+' : ''}${v.toLocaleString('fr-FR')} %`;
const VAM_MINUTES = ['5', '10', '20', '30', '60'];
/** Above these the heart pays for the conditions, not only for the pace. */
const HOT_C = 25;
const HIGH_M = 1500;

/** A cardio session's page: summary, coach, charts, analysis, laps, zones, route. */
export function SessionDetailPage() {
  const { id } = useParams();
  const sessionId = id && /^\d+$/.test(id) ? Number(id) : null;
  const query = useQuery({
    queryKey: qk.sessionDetail(sessionId ?? -1),
    queryFn: () => analyticsApi.getSessionDetail(sessionId!),
    enabled: sessionId !== null,
  });

  return (
    <div className="page-shell bg-void">
      <div className="page-content analytics-page">
        <Link
          to="/log?tab=cardio"
          className="inline-flex min-h-11 items-center gap-1 text-sm font-sans text-text-muted hover:text-neon-cyan"
        >
          <ArrowLeft className="w-4 h-4" />
          Journal
        </Link>
        {sessionId === null ? (
          <EmptyState message="Séance introuvable" />
        ) : query.isLoading ? (
          <LoadingState message="Chargement de la séance…" />
        ) : query.isError || !query.data ? (
          <ErrorState message="Séance introuvable ou indisponible" onRetry={() => query.refetch()} />
        ) : (
          <SessionView detail={query.data} />
        )}
      </div>
    </div>
  );
}

function SessionView({ detail }: { detail: ActivityDetail }) {
  const coach = useCoachName();
  const { session } = detail;
  // The post-session notification opens /log/sessions/{id}?rpe=1.
  const [params] = useSearchParams();
  const foot = isFootSport(session.sport);
  const icon = createElement(getSportIconComponent(session.sport), { size: 'lg', className: getSportColor(session.sport) });
  const rows = detail.streams ? chartRows(detail.streams, session.sport) : [];
  const day = parseLocalDate(session.date).toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const start = session.start_time ? new Date(session.start_time).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null;
  const speed = session.avg_speed_mps ? `${(session.avg_speed_mps * 3.6).toFixed(1)} km/h` : '—';
  const gap = foot ? detail.terrain?.gap_sec_km : null;
  const climbs = detail.terrain && Object.keys(detail.terrain.vam).length > 0;

  return (
    <>
      <header className="flex items-start gap-3 animate-fade-down">
        {icon}
        <div className="min-w-0 flex-1">
          <p className="page-eyebrow">Ta séance en détail</p>
          <h1 className="page-title break-words">
            {session.name || sportLabel(session.sport)}
          </h1>
          <p className="text-xs sm:text-sm font-sans text-text-muted mt-1">
            {day}
            {start && ` · ${start}`} · {sportLabel(session.sport)} · {SOURCE_LABEL[session.source] ?? session.source}
          </p>
        </div>
        {session.rpe != null && (
          <span className="flex shrink-0 items-center gap-1">
            <RpeBadge rpe={session.rpe} />
            <GlossaryLink term="rpe" />
          </span>
        )}
      </header>

      {session.rpe == null && <RpePicker sessionId={session.id} autoFocus={params.get('rpe') === '1'} />}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
        <Stat label="Durée" value={formatDurationCompact(session.moving_time_sec ?? session.duration_sec)} />
        <Stat label="Distance" value={km(session.distance_m)} />
        <Stat
          label={foot ? 'Allure' : 'Vitesse'}
          value={foot ? pace(session.avg_pace_sec_km) : speed}
          sub={gap ? `GAP ${pace(gap)}` : undefined}
        />
        <Stat label="FC moy / max" value={session.avg_hr ? `${session.avg_hr} / ${session.max_hr ?? '—'}` : '—'} />
        <Stat label="Dénivelé +" value={session.ascent_m ? `${Math.round(session.ascent_m)} m` : '—'} />
        <Stat label="Cadence" value={session.avg_cadence ? `${session.avg_cadence}` : '—'} />
        <Stat label="Puissance" value={session.avg_watts ? `${session.avg_watts} W` : '—'} />
        <Stat label="Calories" value={session.calories ? `${session.calories} kcal` : '—'} />
      </div>

      {session.sport === 'strength' && (
        <LinkedStrengthLog
          activityId={session.id}
          logId={detail.strength_log_id ?? null}
          unlinkedLogId={detail.strength_unlinked_log_id ?? null}
          source={session.source}
        />
      )}

      {detail.feedback && (
        <Panel
          title={
            <span className="flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              {detail.feedback.source === 'agent' ? `Le regard de ${coach}` : 'Calculé à partir de la séance'}
            </span>
          }
          titleTone="text-neon-cyan"
        >
          <p className="text-sm font-sans text-text-secondary whitespace-pre-line">{detail.feedback.text}</p>
        </Panel>
      )}

      {session.notes && (
        <Panel title="Notes">
          <p className="text-sm font-sans text-text-secondary whitespace-pre-line">{session.notes}</p>
        </Panel>
      )}

      {rows.length > 0 ? (
        <Panel title="Au fil de la séance">
          <div className="space-y-4">
            <StreamChart rows={rows} dataKey="hr" label="Fréquence cardiaque (bpm)" color={CHART.red} format={(v) => `${Math.round(v)}`} />
            <StreamChart
              rows={rows}
              dataKey="pace"
              label={foot ? 'Allure (min/km)' : 'Vitesse (km/h)'}
              color={COLORS.neonGold}
              format={foot ? (v) => formatPace(v) : (v) => v.toFixed(1)}
              reversed={foot}
            />
            <StreamChart rows={rows} dataKey="altitude" label="Altitude (m)" color={CHART.green} format={(v) => `${Math.round(v)}`} area />
          </div>
        </Panel>
      ) : (
        <Panel animate={false}>
          <EmptyState
            message="Pas de flux pour cette séance"
            action="Les courbes viennent du fichier FIT : séances Garmin synchronisées ou importées depuis la conservation des flux."
          />
        </Panel>
      )}

      {(detail.metrics || detail.intervals) && (
        <div className="analysis-grid">
          {detail.metrics && <Analysis metrics={detail.metrics} foot={foot} />}
          {detail.intervals && <Intervals intervals={detail.intervals} foot={foot} />}
        </div>
      )}

      {(climbs || gap || detail.weather) && (
        <div className="analysis-grid">
          {detail.terrain && (climbs || gap) && <Terrain terrain={detail.terrain} />}
          {detail.weather && <Weather weather={detail.weather} />}
        </div>
      )}

      {(detail.laps.length > 0 || detail.splits.length > 0) && <SessionBreakdown laps={detail.laps} splits={detail.splits} foot={foot} />}

      <div className="analysis-grid">
        {detail.zones && <Zones zones={detail.zones} />}
        {detail.route && (
          <Panel title="Tracé">
            <RouteTrace route={detail.route} />
          </Panel>
        )}
      </div>
    </>
  );
}

/**
 * The exercises of the Muscu log recorded with this strength activity, or the
 * offer to add them: the server says which log is linked (`strength_log_id`).
 */
function LinkedStrengthLog({
  activityId,
  logId,
  unlinkedLogId,
  source,
}: {
  activityId: number;
  logId: number | null;
  unlinkedLogId: number | null;
  source: string;
}) {
  const log = useQuery({
    queryKey: qk.strengthSession(logId ?? -1),
    queryFn: () => strengthApi.getSession(logId!),
    enabled: logId !== null,
  });
  const openDraft = useOpenDraft();
  const exercises = log.data?.exercises ?? [];
  if (logId === null) {
    const watch = source === 'garmin_connect' || source === 'fit_file';
    return (
      <Panel title="Charges">
        <p className="text-sm font-sans text-text-secondary mb-3">
          {watch
            ? 'Ta montre ne transmet pas tes charges. Ajoute-les pour suivre tes records et ta progression.'
            : 'Ajoute tes exercices et tes charges pour suivre tes records et ta progression.'}
        </p>
        {unlinkedLogId !== null && (
          <div className="mb-3">
            <SameDayLogWarning logId={unlinkedLogId} />
          </div>
        )}
        <Button variant="gold" strong className="min-h-11" loading={openDraft.isPending} onClick={() => openDraft.mutate(activityId)}>
          <Dumbbell className="w-4 h-4" aria-hidden />
          Ajoute tes charges
        </Button>
        {openDraft.isError && (
          <p role="alert" className="mt-2 text-xs font-sans text-danger-red">{readableError(openDraft.error)}</p>
        )}
      </Panel>
    );
  }
  if (exercises.length === 0) return null;
  return (
    <Panel title="Exercices">
      <StrengthExercises exercises={exercises} />
      <Link
        to={`/log?session=${logId}`}
        className="mt-2 inline-flex min-h-11 items-center text-sm font-sans text-text-muted hover:text-neon-cyan"
      >
        Ouvrir le log Muscu
      </Link>
    </Panel>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="analysis-card min-w-0">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="text-xl sm:text-2xl font-semibold text-text-primary mt-2 tabular-nums break-words">{value}</div>
      {sub && <div className="text-[11px] sm:text-xs font-sans text-neon-gold truncate">{sub}</div>}
    </div>
  );
}

function Row({ label, value, hint, term }: { label: string; value: ReactNode; hint?: string; term?: GlossaryId }) {
  return (
    <div className="py-2 border-b border-text-muted/10 last:border-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-1 self-center text-xs font-sans text-text-secondary">
          {label}
          {term && <GlossaryLink term={term} />}
        </span>
        <span className="text-sm font-sans text-text-primary text-right">{value}</span>
      </div>
      {hint && <p className="text-[11px] font-sans text-text-muted mt-0.5">{hint}</p>}
    </div>
  );
}

function Analysis({ metrics, foot }: { metrics: ActivityMetrics; foot: boolean }) {
  return (
    <Panel title="Analyse">
      {metrics.decoupling_pct !== undefined && (
        <Row
          label="Découplage cardiaque"
          term="decouplage"
          value={pct(metrics.decoupling_pct)}
          hint="Évolution de la vitesse par battement en seconde moitié. À interpréter avec le terrain, la chaleur et la durée."
        />
      )}
      {metrics.hr_drift_pct !== undefined && (
        <Row label="Dérive de la FC" term="derive-fc" value={pct(metrics.hr_drift_pct)} hint="FC moyenne de la 2e moitié par rapport à la 1re." />
      )}
      {foot && metrics.pace_first_half_sec_km !== undefined && metrics.pace_second_half_sec_km !== undefined && (
        <Row
          label="Allure 1re / 2e moitié"
          value={`${formatPace(metrics.pace_first_half_sec_km)} / ${formatPace(metrics.pace_second_half_sec_km)}`}
          hint={metrics.pace_fade_pct !== undefined ? `Ralentissement : ${pct(metrics.pace_fade_pct)} (négatif = 2e moitié plus rapide).` : undefined}
        />
      )}
      {!foot && metrics.pace_fade_pct !== undefined && (
        <Row label="Ralentissement en 2e moitié" value={pct(metrics.pace_fade_pct)} />
      )}
      {metrics.pace_cv_pct !== undefined && (
        <Row label="Variabilité de l'allure" value={`${metrics.pace_cv_pct.toLocaleString('fr-FR')} %`} hint="Écart-type rapporté à la moyenne, arrêts exclus." />
      )}
      {metrics.cadence_avg !== undefined && (
        <Row
          label="Cadence moyenne"
          value={`${metrics.cadence_avg}${foot ? ' pas/min' : ' tr/min'}`}
          hint={metrics.cadence_cv_pct !== undefined ? `Variabilité : ${metrics.cadence_cv_pct.toLocaleString('fr-FR')} %` : undefined}
        />
      )}
      {metrics.power_avg !== undefined && (
        <Row
          label="Puissance moy. / normalisée"
          value={`${metrics.power_avg} / ${metrics.power_np ?? '—'} W`}
          hint={metrics.power_vi !== undefined ? `Indice de variabilité : ${metrics.power_vi.toLocaleString('fr-FR')}` : undefined}
        />
      )}
    </Panel>
  );
}

function Terrain({ terrain }: { terrain: ActivityTerrain }) {
  const effort = terrain.grade_factor !== null ? Math.round((terrain.grade_factor - 1) * 100) : null;
  return (
    <Panel title="Pente et montée">
      {terrain.gap_sec_km !== null && (
        <Row
          label="Allure ajustée à la pente (GAP)"
          term="gap"
          value={pace(terrain.gap_sec_km)}
          hint={`L'allure à plat pour le même effort (coût énergétique de Minetti)${
            effort ? ` : la pente a pesé ${pct(effort)}.` : '.'
          }`}
        />
      )}
      {VAM_MINUTES.filter((m) => terrain.vam[m] !== undefined).map((m) => (
        <Row key={m} label={`Vitesse ascensionnelle ${m} min`} term="vam" value={`${terrain.vam[m].toLocaleString('fr-FR')} m/h`} />
      ))}
    </Panel>
  );
}

function Weather({ weather }: { weather: ActivityWeather }) {
  const hour = new Date(weather.observed_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const temp = weather.temperature_c;
  const altitude = weather.start_altitude_m;
  return (
    <Panel title="Météo au départ">
      {temp !== null && (
        <Row
          label="Température"
          value={`${Math.round(temp)} °C`}
          hint={temp >= HOT_C ? 'Chaleur : à allure égale, la FC monte plus vite.' : undefined}
        />
      )}
      {weather.humidity_pct !== null && <Row label="Humidité" value={`${Math.round(weather.humidity_pct)} %`} />}
      {weather.wind_kmh !== null && <Row label="Vent" value={`${Math.round(weather.wind_kmh)} km/h`} />}
      {altitude !== null && (
        <Row
          label="Altitude du départ"
          value={`${Math.round(altitude).toLocaleString('fr-FR')} m`}
          hint={altitude >= HIGH_M ? "Altitude : moins d'oxygène, l'allure seuil baisse." : undefined}
        />
      )}
      <p className="text-[11px] font-sans text-text-muted mt-2">Open-Meteo, relevé de {hour}.</p>
    </Panel>
  );
}

function Intervals({ intervals, foot }: { intervals: ActivityIntervals; foot: boolean }) {
  return (
    <Panel title="Fractionné détecté">
      <p className="text-sm font-sans text-text-secondary mb-3">
        {intervals.count} × {formatElapsed(intervals.work_avg_sec)}
        {intervals.rest_avg_sec ? ` · récup ${formatElapsed(intervals.rest_avg_sec)}` : ''}
        {intervals.warmup_sec ? ` · échauffement ${formatElapsed(intervals.warmup_sec)}` : ''}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-sans">
          <thead className="text-text-muted">
            <tr className="text-left">
              <th className="py-1 pr-2 font-normal">N°</th>
              <th className="py-1 pr-2 font-normal">Durée</th>
              <th className="py-1 pr-2 font-normal">Distance</th>
              {foot && <th className="py-1 pr-2 font-normal">Allure</th>}
              <th className="py-1 font-normal">FC</th>
            </tr>
          </thead>
          <tbody className="text-text-primary">
            {intervals.work.map((rep) => (
              <tr key={rep.n} className="border-t border-text-muted/10">
                <td className="py-1 pr-2">{rep.n}</td>
                <td className="py-1 pr-2">{formatElapsed(rep.duration_sec)}</td>
                <td className="py-1 pr-2">{rep.distance_m ? `${Math.round(rep.distance_m)} m` : '—'}</td>
                {foot && <td className="py-1 pr-2">{rep.pace_sec_km ? formatPace(rep.pace_sec_km) : '—'}</td>}
                <td className="py-1">{rep.avg_hr ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 space-y-0.5 text-[11px] font-sans text-text-muted">
        {intervals.pace_cv_pct !== null && <p>Régularité des allures : {intervals.pace_cv_pct.toLocaleString('fr-FR')} % d'écart.</p>}
        {intervals.hr_progression_pct !== null && (
          <p>FC de la dernière répétition vs la première : {pct(intervals.hr_progression_pct)}.</p>
        )}
      </div>
    </Panel>
  );
}

function SessionBreakdown({ laps, splits, foot }: { laps: ActivityLap[]; splits: ActivitySplit[]; foot: boolean }) {
  const [tab, setTab] = useState<'laps' | 'splits'>(laps.length ? 'laps' : 'splits');
  return <section className="space-y-4" aria-label="Détail des tours et kilomètres">
    <div className="flex gap-2" role="group" aria-label="Découpage de la séance">
      {laps.length > 0 && <button type="button" className="analysis-tab" aria-pressed={tab === 'laps'} onClick={() => setTab('laps')}>Tours · {laps.length}</button>}
      {splits.length > 0 && <button type="button" className="analysis-tab" aria-pressed={tab === 'splits'} onClick={() => setTab('splits')}>Kilomètres · {splits.length}</button>}
    </div>
    {tab === 'laps' ? <LapsTable laps={laps} foot={foot} /> : <SplitsTable splits={splits} />}
  </section>;
}

function LapsTable({ laps, foot }: { laps: ActivityLap[]; foot: boolean }) {
  const [selected, setSelected] = useState<ActivityLap | null>(null);
  const hasIntensity = laps.some((lap) => lap.intensity !== null);
  return (
    <>
    <Panel title={`Tours (${laps.length})`}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-sans whitespace-nowrap">
          <thead className="text-text-muted">
            <tr className="text-left">
              <th className="py-1 pr-3 font-normal">N°</th>
              {hasIntensity && <th className="py-1 pr-3 font-normal">Type</th>}
              <th className="py-1 pr-3 font-normal">Durée</th>
              <th className="py-1 pr-3 font-normal">Distance</th>
              <th className="py-1 pr-3 font-normal">{foot ? 'Allure' : 'Vitesse'}</th>
              <th className="py-1 pr-3 font-normal">FC moy</th>
              <th className="py-1 pr-3 font-normal">FC max</th>
              <th className="py-1 font-normal">Cadence</th>
            </tr>
          </thead>
          <tbody className="text-text-primary">
            {laps.map((lap) => (
              <tr key={lap.n} className="border-t border-text-muted/10">
                <td className="py-1 pr-3"><button type="button" className="min-h-11 min-w-11 text-neon-cyan underline" aria-label={`Détail du tour ${lap.n}`} onClick={() => setSelected(lap)}>{lap.n}</button></td>
                {hasIntensity && <td className="py-1 pr-3 text-text-secondary">{intensityLabel(lap.intensity)}</td>}
                <td className="py-1 pr-3">{formatElapsed(lap.duration_sec)}</td>
                <td className="py-1 pr-3">{km(lap.distance_m)}</td>
                <td className="py-1 pr-3">
                  {foot ? pace(lap.pace_sec_km) : lap.speed_mps ? `${(lap.speed_mps * 3.6).toFixed(1)} km/h` : '—'}
                </td>
                <td className="py-1 pr-3">{lap.avg_hr ?? '—'}</td>
                <td className="py-1 pr-3">{lap.max_hr ?? '—'}</td>
                <td className="py-1">{lap.cadence ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
    <Modal open={selected !== null} onClose={() => setSelected(null)} className="max-w-md p-6">
      <ModalHeader title={`Tour ${selected?.n ?? ''}`} onClose={() => setSelected(null)} />
      {selected && <div className="mt-4">
        {selected.intensity !== null && <Row label="Type" value={intensityLabel(selected.intensity)} />}
        <Row label="Durée" value={formatElapsed(selected.duration_sec)} />
        <Row label="Distance" value={km(selected.distance_m)} />
        <Row label={foot ? 'Allure' : 'Vitesse'} value={foot ? pace(selected.pace_sec_km) : selected.speed_mps ? `${(selected.speed_mps * 3.6).toFixed(1)} km/h` : '—'} />
        <Row label="FC moyenne / maximale" value={`${selected.avg_hr ?? '—'} / ${selected.max_hr ?? '—'} bpm`} />
        <Row label="Cadence" value={selected.cadence == null ? '—' : `${selected.cadence} ${foot ? 'pas/min' : 'tr/min'}`} />
      </div>}
    </Modal>
    </>
  );
}

function SplitsTable({ splits }: { splits: ActivitySplit[] }) {
  return (
    <Panel title="Kilomètres">
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-sans whitespace-nowrap">
          <thead className="text-text-muted">
            <tr className="text-left">
              <th className="py-1 pr-3 font-normal">Km</th>
              <th className="py-1 pr-3 font-normal">Durée</th>
              <th className="py-1 pr-3 font-normal">Allure</th>
              <th className="py-1 pr-3 font-normal">FC moy</th>
              <th className="py-1 font-normal">Dénivelé</th>
            </tr>
          </thead>
          <tbody className="text-text-primary">
            {splits.map((split) => (
              <tr key={split.n} className="border-t border-text-muted/10">
                <td className="py-1 pr-3">{split.n}</td>
                <td className="py-1 pr-3">{formatElapsed(split.duration_sec)}</td>
                <td className="py-1 pr-3">{pace(split.pace_sec_km)}</td>
                <td className="py-1 pr-3">{split.avg_hr ?? '—'}</td>
                <td className="py-1">{split.elevation_m !== null ? `${Math.round(split.elevation_m)} m` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Zones({ zones }: { zones: NonNullable<ActivityDetail['zones']> }) {
  const values = [zones.z1, zones.z2, zones.z3, zones.z4, zones.z5];
  const total = values.reduce((a, b) => a + b, 0) || 1;
  return (
    <Panel title="Zones cardiaques">
      <div className="flex h-3 rounded overflow-hidden gap-0.5 mb-3" aria-hidden>
        {values.map((sec, i) =>
          sec > 0 ? (
            <div key={i} style={{ width: `${(sec / total) * 100}%`, backgroundColor: HR_ZONE_COLORS[i] }} />
          ) : null,
        )}
      </div>
      <ul className="space-y-1">
        {values.map((sec, i) => (
          <li key={i} className="flex items-center justify-between gap-2 text-xs font-sans">
            <span className="flex items-center gap-2 text-text-secondary">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: HR_ZONE_COLORS[i] }} />
              {ZONE_NAME[i]}
            </span>
            <span className={cn('text-text-primary', sec === 0 && 'text-text-muted')}>
              {formatDurationCompact(sec)} · {Math.round((sec / total) * 100)} %
            </span>
          </li>
        ))}
      </ul>
      <Link
        to={glossaryHref('zones')}
        className="mt-2 inline-flex min-h-11 items-center text-xs font-sans text-text-muted hover:text-neon-cyan"
      >
        Comprendre les zones
      </Link>
    </Panel>
  );
}
