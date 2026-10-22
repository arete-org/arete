import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowLeft, Printer } from 'lucide-react';
import { ErrorState, LoadingState } from '@/components';
import { Intensity, WeightLine } from '@/components/body/BodyMarks';
import { Button } from '@/components/ui';
import { settingsApi } from '@/lib/api';
import { bodyApi, bodyKeys, formatKg, shortDate, useAthleteToday, weightSentence, type BodyReport } from '@/lib/bodyLog';
import { parseLocalDate } from '@/lib/dates';
import { capitalized, formatDecimal, sportLabel } from '@/lib/fr';
import { qk } from '@/lib/queryKeys';

const longDate = (iso: string) =>
  parseLocalDate(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

/** « 1 h 05 » or « 42 min ». */
function minutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

const dash = (value: number | null | undefined, unit = '') => (value == null ? '—' : `${value}${unit}`);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="report-section space-y-3">
      <h2 className="text-base font-sans font-semibold text-text-primary">{title}</h2>
      {children}
    </section>
  );
}

function Table({ caption, head, rows }: { caption: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="report-table overflow-x-auto">
      <table className="w-full text-xs sm:text-sm font-sans">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-left text-text-muted">
            {head.map((h) => (
              <th key={h} scope="col" className="py-1.5 pr-3 font-normal whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i} className="border-t border-border align-top">
              {cells.map((cell, j) => (
                <td key={j} className="py-1.5 pr-3 tabular-nums text-text-secondary">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const Empty = ({ children }: { children: string }) => <p className="text-sm font-sans text-text-muted">{children}</p>;

/** The printed document: nothing in it depends on the screen's theme or width. */
export function Report({ report, today, athlete }: { report: BodyReport; today: string; athlete?: string | null }) {
  const maxTss = Math.max(1, ...report.weeks.map((w) => w.tss));
  return (
    <article className="health-report space-y-6" aria-labelledby="report-title">
      <header className="space-y-1">
        <h1 id="report-title" className="page-title">Rapport d’entraînement et de santé</h1>
        <p className="text-sm font-sans text-text-secondary">
          Du {longDate(report.start)} au {longDate(report.end)} · {report.weeks.length} semaines
          {athlete ? ` · ${athlete}` : ''}
        </p>
        <p className="text-xs font-sans text-text-muted">
          Établi par Arete le {longDate(today)}, à partir des séances de la montre et des saisies de
          l’athlète. Ce document n’est pas un avis médical.
        </p>
      </header>

      <Section title="En bref">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Séances', String(report.totals.sessions)],
            ['Temps total', minutes(report.totals.duration_min)],
            [
              'Douleurs notées',
              report.totals.pain_entries
                ? `${report.totals.pain_entries} (max ${report.totals.max_pain}/10)`
                : 'aucune',
            ],
            ['Poids', report.weight.latest ? formatKg(report.weight.latest.weight_kg) : '—'],
          ].map(([label, value]) => (
            <div key={label} className="ui-inset p-3">
              <dt className="text-xs font-sans text-text-muted">{label}</dt>
              <dd className="text-lg font-sans font-semibold tabular-nums text-text-primary">{value}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Charge hebdomadaire">
        <Table
          caption="Charge par semaine"
          head={['Semaine', 'Séances', 'Durée', 'Distance', 'TSS estimé', 'ACWR']}
          rows={report.weeks.map((w) => [
            `${shortDate(w.week_start)} – ${shortDate(w.week_end)}`,
            w.sessions,
            minutes(w.duration_min),
            w.distance_km ? `${formatDecimal(w.distance_km, 1)} km` : '—',
            <span key="tss" className="flex items-center gap-2">
              <span className="w-8 text-right">{w.tss}</span>
              <span aria-hidden className="report-bar h-2 rounded-sm bg-neon-cyan" style={{ width: `${(w.tss / maxTss) * 64}px` }} />
            </span>,
            w.acwr == null ? '—' : formatDecimal(w.acwr, 2),
          ])}
        />
        <p className="text-xs font-sans text-text-muted">
          TSS estimé à partir de la durée, de la fréquence cardiaque ou du RPE. ACWR : charge des 7 derniers jours
          rapportée à la moyenne des 4 dernières semaines, en fin de semaine (zone habituelle de 0,8 à 1,3).
        </p>
      </Section>

      <Section title="Douleurs">
        {report.pain.length ? (
          <>
            <Table
              caption="Douleurs par zone"
              head={['Zone', 'Dernière', 'Maximum', 'Saisies']}
              rows={report.pain_areas.map((a) => [
                <span key="z" className="text-text-primary">{capitalized(a.label)}</span>,
                <span key="d"><Intensity value={a.last_intensity} /> le {shortDate(a.last_date)}</span>,
                <Intensity key="m" value={a.max_intensity} />,
                a.entries,
              ])}
            />
            <Table
              caption="Douleurs notées, de la plus ancienne à la plus récente"
              head={['Jour', 'Zone', 'Intensité', 'Note']}
              rows={report.pain.map((p) => [
                shortDate(p.date, true),
                capitalized(p.label),
                <Intensity key="i" value={p.intensity} />,
                <span key="n" className="whitespace-normal break-words">{p.note ?? ''}</span>,
              ])}
            />
            <p className="text-xs font-sans text-text-muted">Intensité déclarée de 0 (aucune) à 10 (maximale).</p>
          </>
        ) : (
          <Empty>Aucune douleur notée sur la période.</Empty>
        )}
      </Section>

      <Section title="Poids">
        <p className="text-sm font-sans text-text-secondary">{weightSentence(report.weight)}</p>
        <WeightLine weights={report.weights} />
        {report.weights.length > 0 && (
          <Table
            caption="Poids notés"
            head={['Jour', 'Poids']}
            rows={report.weights.map((w) => [shortDate(w.date, true), formatKg(w.weight_kg)])}
          />
        )}
      </Section>

      <Section title="Préparation et sommeil">
        {report.readiness.length ? (
          <Table
            caption="Mesures de la montre"
            head={['Jour', 'Préparation Garmin', 'Préparation estimée', 'Sommeil', 'FC repos', 'VFC']}
            rows={report.readiness.map((r) => [
              shortDate(r.date, true),
              dash(r.garmin_readiness, '/100'),
              dash(r.readiness, '/100'),
              dash(r.sleep_score, '/100'),
              dash(r.resting_hr, ' bpm'),
              dash(r.hrv, ' ms'),
            ])}
          />
        ) : (
          <Empty>Aucune mesure de la montre sur la période.</Empty>
        )}
      </Section>

      <Section title="Check-ins du matin">
        {report.checkins.length ? (
          <>
            <Table
              caption="Réponses au check-in du matin"
              head={['Jour', 'Sommeil', 'Jambes', 'Motivation / stress']}
              rows={report.checkins.map((c) => [shortDate(c.date, true), dash(c.sleep, '/5'), dash(c.legs, '/5'), dash(c.mood, '/5')])}
            />
            <p className="text-xs font-sans text-text-muted">De 1 (très mauvais) à 5 (excellent).</p>
          </>
        ) : (
          <Empty>Aucun check-in sur la période.</Empty>
        )}
      </Section>

      <Section title="Séances">
        {report.sessions.length ? (
          <Table
            caption="Séances réalisées"
            head={['Jour', 'Sport', 'Durée', 'Distance', 'FC moy.', 'RPE', 'TSS']}
            rows={report.sessions.map((s) => [
              shortDate(s.date, true),
              sportLabel(s.sport),
              minutes(s.duration_min),
              s.distance_km ? `${formatDecimal(s.distance_km, 1)} km` : '—',
              dash(s.avg_hr),
              dash(s.rpe),
              s.tss,
            ])}
          />
        ) : (
          <Empty>Aucune séance sur la période.</Empty>
        )}
      </Section>
    </article>
  );
}

/** /sante/rapport: the report on screen, printed or saved as PDF by the browser. */
export function HealthReportPage() {
  const query = useQuery({ queryKey: bodyKeys.report, queryFn: bodyApi.report });
  const settings = useQuery({ queryKey: qk.settings, queryFn: settingsApi.get });
  const name = settings.data?.display_name;
  const today = useAthleteToday();

  return (
    <div className="page-shell space-y-5">
      <div className="report-toolbar flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Link to="/sante" className="inline-flex min-h-11 items-center gap-1 text-sm font-sans text-text-muted hover:text-neon-cyan">
          <ArrowLeft aria-hidden className="w-4 h-4" />
          Santé
        </Link>
        <Button variant="cyan" size="lg" strong disabled={!query.data} onClick={() => window.print()}>
          <Printer aria-hidden className="size-4" />
          Imprimer ou enregistrer en PDF
        </Button>
      </div>
      {query.isLoading ? (
        <LoadingState message="Préparation du rapport…" />
      ) : query.isError || !query.data ? (
        <ErrorState message="Rapport indisponible" onRetry={() => query.refetch()} />
      ) : (
        <Report report={query.data} today={today} athlete={name && name !== 'Athlète' ? name : null} />
      )}
    </div>
  );
}
