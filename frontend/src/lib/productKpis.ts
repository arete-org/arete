import { KPI_KEYS, type KpiCell, type KpiKey, type KpiWeek } from './api';

/** What each indicator counts, in the server's words (services/product_kpis.py). */
export const KPI_LABELS: Record<KpiKey, { label: string; detail: string }> = {
  active_accounts: { label: 'Comptes actifs', detail: 'action ou visite dans la semaine / comptes' },
  push_subscribers: { label: 'Abonnés aux notifications', detail: 'comptes abonnés / comptes' },
  strength_logged: { label: 'Séances de force saisies', detail: 'saisies / activités de force importées' },
  checkins_answered: { label: 'Check-ins répondus', detail: 'répondus / envoyés' },
  briefings_reacted: { label: 'Briefings avec réaction', detail: 'jours avec réaction / jours avec briefing' },
  weekly_reviews_accepted: { label: 'Contrats du dimanche acceptés', detail: 'bilans acceptés / bilans écrits' },
  first_action_hours: { label: 'Délai avant la 1re action', detail: 'médiane des nouveaux comptes' },
  retention_30d: { label: 'Rétention à 30 jours', detail: 'revenus après 30 jours / inscrits de la semaine' },
};

const PERCENT = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 0 });
const HOURS = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const WEEK = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

/** The headline figure: a percentage, or hours for the median delay; « — » when nothing is counted. */
export function kpiValue(key: KpiKey, cell: KpiCell): string {
  if (cell.value === null) return '—';
  return key === 'first_action_hours' ? `${HOURS.format(cell.value)} h` : PERCENT.format(cell.value);
}

/** The counts behind it. */
export function kpiCounts(key: KpiKey, cell: KpiCell): string {
  return key === 'first_action_hours'
    ? `${cell.numerator} sur ${cell.denominator} comptes`
    : `${cell.numerator} / ${cell.denominator}`;
}

/** « 12/10/2026 », read as a calendar day whatever the browser's timezone. */
export function weekLabel(week: KpiWeek): string {
  const [year, month, day] = week.week_start.split('-').map(Number);
  return WEEK.format(new Date(year, month - 1, day));
}

function csvField(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Every week and indicator as the table shows them, with raw values for a spreadsheet. */
export function kpisCsv(weeks: KpiWeek[]): string {
  const header = ['Semaine (lundi)', 'En cours'];
  for (const key of KPI_KEYS) {
    const { label } = KPI_LABELS[key];
    header.push(label, `${label} - numérateur`, `${label} - dénominateur`);
  }
  const rows = weeks.map((week) => {
    const row: (string | number | null)[] = [week.week_start, week.current ? 'oui' : 'non'];
    for (const key of KPI_KEYS) {
      const cell = week.indicators[key];
      row.push(cell.value, cell.numerator, cell.denominator);
    }
    return row;
  });
  return [header, ...rows].map((row) => row.map(csvField).join(',')).join('\n') + '\n';
}

export function downloadKpisCsv(weeks: KpiWeek[]): void {
  // The byte-order mark lets spreadsheet software read the accents as UTF-8.
  const blob = new Blob(['﻿', kpisCsv(weeks)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `arete-indicateurs-${weeks[0]?.week_start ?? 'vide'}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
