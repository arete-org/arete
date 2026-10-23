import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { ErrorState, LoadingState } from '@/components';
import { BodyLogEntry } from '@/components/body/BodyLogEntry';
import { PainForm } from '@/components/body/PainForm';
import { Button, Panel } from '@/components/ui';
import { Intensity, WeightLine } from '@/components/body/BodyMarks';
import {
  afterBodyWrite, bodyApi, bodyKeys, formatKg, shortDate, weightSentence,
  type AreaTrend, type PainEntry, type WeightEntry,
} from '@/lib/bodyLog';
import { capitalized } from '@/lib/fr';
import { readableError } from '@/lib/utils';

const WINDOW_DAYS = 56;

/** Delete in two taps: health data the athlete withdraws is erased for good. */
function DeleteButton({ label, onConfirm, pending }: { label: string; onConfirm: () => void; pending: boolean }) {
  const [asking, setAsking] = useState(false);
  return asking ? (
    <span className="flex flex-wrap gap-2">
      <Button size="sm" variant="danger" strong loading={pending} onClick={onConfirm} className="min-h-11">
        Supprimer définitivement
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setAsking(false)} className="min-h-11">
        Garder
      </Button>
    </span>
  ) : (
    <Button size="sm" variant="ghost" aria-label={label} onClick={() => setAsking(true)} className="min-h-11">
      Supprimer
    </Button>
  );
}

function PainRow({ entry }: { entry: PainEntry }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const remove = useMutation({
    mutationFn: () => bodyApi.deletePain(entry.id),
    onSuccess: () => afterBodyWrite(client),
  });
  if (editing) {
    return (
      <li className="ui-inset p-3">
        <PainForm entry={entry} onCancel={() => setEditing(false)} onSaved={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 text-sm font-sans">
        <p className="text-text-primary">
          <span className="text-text-muted">{shortDate(entry.date, true)}</span> · {entry.label} · <Intensity value={entry.intensity} />
        </p>
        {entry.note && <p className="mt-0.5 break-words text-xs text-text-secondary">{entry.note}</p>}
        {remove.isError && <p role="alert" className="text-xs text-danger-red">Suppression impossible : {readableError(remove.error)}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button size="sm" variant="ghost" className="min-h-11" aria-label={`Corriger la douleur du ${shortDate(entry.date)} (${entry.label})`} onClick={() => setEditing(true)}>
          Corriger
        </Button>
        <DeleteButton
          label={`Supprimer la douleur du ${shortDate(entry.date)} (${entry.label})`}
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      </div>
    </li>
  );
}

function WeightRow({ entry }: { entry: WeightEntry }) {
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () => bodyApi.deleteWeight(entry.date),
    onSuccess: () => afterBodyWrite(client),
  });
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm font-sans">
      <span>
        <span className="text-text-muted">{shortDate(entry.date, true)}</span> ·{' '}
        <span className="tabular-nums text-text-primary">{formatKg(entry.weight_kg)}</span>
      </span>
      <DeleteButton label={`Supprimer le poids du ${shortDate(entry.date)}`} pending={remove.isPending} onConfirm={() => remove.mutate()} />
    </li>
  );
}

function AreasTable({ areas }: { areas: AreaTrend[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm font-sans">
        <caption className="sr-only">Douleurs par zone sur 8 semaines</caption>
        <thead>
          <tr className="text-left text-xs text-text-muted">
            <th scope="col" className="py-2 pr-3 font-normal">Zone</th>
            <th scope="col" className="py-2 pr-3 font-normal">Dernière</th>
            <th scope="col" className="py-2 pr-3 font-normal">Max</th>
            <th scope="col" className="py-2 font-normal">Saisies</th>
          </tr>
        </thead>
        <tbody>
          {areas.map((a) => (
            <tr key={`${a.area}-${a.side}`} className="border-t border-border">
              <th scope="row" className="py-2 pr-3 text-left font-normal text-text-primary">{capitalized(a.label)}</th>
              <td className="py-2 pr-3 whitespace-nowrap">
                <Intensity value={a.last_intensity} /> <span className="text-text-muted">le {shortDate(a.last_date)}</span>
              </td>
              <td className="py-2 pr-3"><Intensity value={a.max_intensity} /></td>
              <td className="py-2 tabular-nums text-text-secondary">{a.entries}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Santé: record pain and weight, read their trend, open the physio report. */
export function HealthPage() {
  const query = useQuery({ queryKey: bodyKeys.trend(WINDOW_DAYS), queryFn: () => bodyApi.trend(WINDOW_DAYS) });
  const trend = query.data;

  return (
    <div className="page-shell space-y-5">
      <header>
        <p className="page-eyebrow">Ton corps</p>
        <h1 className="page-title">Santé</h1>
        <p className="mt-2 text-sm text-text-muted">
          Douleurs et poids que tu notes, sur 8 semaines. Le coach en tient compte ; rien ne quitte ton compte sans toi.
        </p>
      </header>

      <Panel title="Noter">
        <BodyLogEntry trendLink={false} />
      </Panel>

      {query.isLoading ? (
        <LoadingState message="Chargement du suivi…" />
      ) : query.isError || !trend ? (
        <ErrorState message="Suivi indisponible" onRetry={() => query.refetch()} />
      ) : (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title="Douleurs par zone">
              {trend.areas.length ? (
                <AreasTable areas={trend.areas} />
              ) : (
                <p className="text-sm font-sans text-text-muted">Aucune douleur notée sur 8 semaines.</p>
              )}
            </Panel>
            <Panel title="Poids">
              <p className="mb-3 text-sm font-sans text-text-secondary">{weightSentence(trend.weight)}</p>
              <WeightLine weights={trend.weights} />
              {trend.weights.length > 0 && (
                <ul className="mt-2 divide-y divide-border" aria-label="Poids notés">
                  {[...trend.weights].reverse().map((w) => <WeightRow key={w.date} entry={w} />)}
                </ul>
              )}
            </Panel>
          </div>

          <Panel title="Journal des douleurs">
            {trend.pain.length ? (
              <ul className="divide-y divide-border" aria-label="Douleurs notées">
                {trend.pain.map((p) => <PainRow key={p.id} entry={p} />)}
              </ul>
            ) : (
              <p className="text-sm font-sans text-text-muted">Rien à signaler pour l’instant.</p>
            )}
          </Panel>
        </>
      )}

      <Panel title="Rapport pour ton kiné ou ton médecin">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs font-sans text-text-muted">
            Huit semaines sur une page : charge, séances, douleurs, poids, préparation et check-ins. À imprimer ou
            enregistrer en PDF.
          </p>
          <Link to="/sante/rapport" className="inline-flex min-h-11 shrink-0 items-center gap-2 text-sm font-sans text-neon-cyan hover:underline">
            <FileText aria-hidden className="size-4" />
            Ouvrir le rapport
          </Link>
        </div>
      </Panel>
    </div>
  );
}
