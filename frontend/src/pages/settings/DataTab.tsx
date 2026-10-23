import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CalendarRange, Download } from 'lucide-react';
import { SystemAlert } from '@/components';
import { Button, Field, Input, Panel } from '@/components/ui';
import { ApiError } from '@/lib/api';
import {
  DEFAULT_EXPORT_TABLES,
  downloadExport,
  EXPORT_TABLES,
  NOT_EXPORTED,
  type ExportFormat,
  type ExportTableId,
} from '@/lib/dataExport';
import { cn } from '@/lib/utils';
import { AccountDeletionPanel } from './AccountDeletionPanel';

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: 'zip', label: 'ZIP (CSV)', hint: 'Un fichier CSV par table, lisible dans un tableur.' },
  { id: 'json', label: 'JSON', hint: 'Un seul fichier, pour un script ou une autre application.' },
];

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.detail) return error.detail;
  return 'Export impossible, réessaie dans un instant.';
}

/** Settings → Données: download the athlete's own data, then possibly erase the account. */
export function DataTab() {
  const [format, setFormat] = useState<ExportFormat>('zip');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [tables, setTables] = useState<ExportTableId[]>(DEFAULT_EXPORT_TABLES);

  const exportMutation = useMutation({
    mutationFn: () => downloadExport({ format, start, end, tables }),
  });

  const toggle = (id: ExportTableId) =>
    setTables((current) => {
      const next = current.includes(id) ? current.filter((t) => t !== id) : [...current, id];
      return EXPORT_TABLES.map((t) => t.id).filter((t) => next.includes(t));
    });

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-sans text-text-primary">Données</h2>

      <Panel level={3} variant="inset" title="Exporter mes données">
        <div className="space-y-4">
          <p className="text-xs text-text-muted font-sans">
            Séances, santé, force, objectifs, bilans, échanges avec le coach, réglages et jeu. Les historiques
            volumineux (courbes, conversations, briefings…) se cochent à part, de préférence sur une période.
          </p>

          <div className="flex flex-wrap gap-2" role="group" aria-label="Format">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={format === f.id}
                onClick={() => setFormat(f.id)}
                className={cn(
                  'px-3 py-2 rounded text-xs font-sans border transition-colors',
                  format === f.id
                    ? 'bg-neon-cyan/10 text-neon-cyan border-neon-cyan/30'
                    : 'text-text-muted border-text-muted/30 hover:text-text-secondary'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-text-muted font-sans">{FORMATS.find((f) => f.id === format)?.hint}</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Du" gap="sm">
              <Input type="date" value={start} max={end || undefined} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="Au" gap="sm">
              <Input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
          <p className="text-xs text-text-muted font-sans flex items-start gap-2">
            <CalendarRange className="w-3 h-3 mt-0.5 shrink-0" aria-hidden />
            Sans date, tout l’historique. La période filtre les séances, la santé et les bilans ; objectifs, faits et
            journal sont toujours complets. Un export dépassant 4 Mo est refusé : réduis alors la période ou passe au ZIP.
          </p>

          {[
            { legend: 'Contenu', optIn: false },
            { legend: 'À la demande (volumineux : choisis une période)', optIn: true },
          ].map((group) => (
            <fieldset key={group.legend}>
              <legend className="text-xs font-sans text-text-muted mb-2">{group.legend}</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {EXPORT_TABLES.filter((t) => Boolean(t.optIn) === group.optIn).map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-sm text-text-secondary font-sans">
                    <input
                      type="checkbox"
                      className="accent-neon-cyan"
                      checked={tables.includes(t.id)}
                      onChange={() => toggle(t.id)}
                    />
                    {t.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}

          <div>
            <p className="text-xs font-sans text-text-muted mb-1">Jamais exporté</p>
            <ul className="list-disc pl-4 space-y-0.5 text-xs text-text-muted font-sans">
              {NOT_EXPORTED.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>

          {exportMutation.isError && (
            <SystemAlert type="error" message={errorMessage(exportMutation.error)} onDismiss={() => exportMutation.reset()} />
          )}

          <Button
            onClick={() => exportMutation.mutate()}
            loading={exportMutation.isPending}
            disabled={tables.length === 0}
          >
            {!exportMutation.isPending && <Download className="w-4 h-4" />}
            {exportMutation.isPending ? 'Préparation…' : 'Télécharger'}
          </Button>
        </div>
      </Panel>

      <Panel level={3} variant="inset" title="Rapport pour ton kiné ou ton médecin">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <p className="text-xs text-text-muted font-sans">
            Huit semaines sur une page : charge, séances, douleurs, poids, préparation et check-ins. À imprimer ou
            enregistrer en PDF depuis ton navigateur.
          </p>
          <Link to="/sante/rapport" className="inline-flex min-h-11 shrink-0 items-center text-sm font-sans text-neon-cyan hover:underline">
            Ouvrir le rapport →
          </Link>
        </div>
      </Panel>

      <Panel level={3} variant="inset" title="Bilan annuel">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <p className="text-xs text-text-muted font-sans">
            L’année en chiffres : volume, sports, records, régularité, forme et force.
          </p>
          <Link
            to="/analytics/bilan"
            className="shrink-0 text-sm font-sans text-neon-cyan hover:underline"
          >
            Voir le bilan →
          </Link>
        </div>
      </Panel>

      <AccountDeletionPanel />
    </div>
  );
}
