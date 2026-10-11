import { CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import type { SyncProgress } from '@/lib/garminSync';
import type { SyncResult } from '@/types';

const LABELS: Record<SyncProgress['stage'], string> = {
  preparing: 'Préparation de la synchronisation',
  fetching: 'Récupération des activités Garmin',
  processing: 'Traitement des activités',
  fit: 'Récupération du fichier FIT',
  saving: 'Enregistrement de l’activité',
  finalizing: 'Finalisation des données',
};

export function GarminSyncProgress({ progress, isPending, result, error }: {
  progress: SyncProgress | null;
  isPending: boolean;
  result?: SyncResult;
  error: Error | null;
}) {
  if (!isPending && !result && !error) return null;
  const failed = !isPending && (Boolean(error) || result?.success === false);
  const partial = !isPending && !failed && Boolean(result?.errors.length);
  const finished = !isPending && !failed;
  const stage = progress?.stage ?? 'preparing';
  // Milestones reserve the last 5% for enrichment; the middle tracks actual work.
  const percent = finished ? 100 : stage === 'finalizing' ? 95
    : stage === 'preparing' ? 0 : stage === 'fetching' ? 5
      : 10 + (progress?.total ? Math.floor(85 * progress.completed / progress.total) : 0);
  const label = failed ? 'Synchronisation interrompue' : partial ? 'Synchronisation terminée avec des erreurs'
    : finished ? 'Synchronisation terminée' : LABELS[stage];
  const Icon = isPending ? Loader2 : failed || partial ? AlertCircle : CheckCircle;
  const color = failed || partial ? 'text-neon-gold' : finished ? 'text-success-green' : 'text-neon-cyan';

  return (
    <div className="rounded border border-text-muted/20 bg-abyss/30 p-4 space-y-3 min-w-0">
      <div className={`flex items-center gap-2 text-sm ${color}`} role="status" aria-live="polite">
        <Icon aria-hidden="true" className={`w-4 h-4 shrink-0 ${isPending ? 'animate-spin motion-reduce:animate-none' : ''}`} />
        <span>{label}</span>
        <span className="ml-auto font-sans text-xs tabular-nums">{percent} %</span>
      </div>
      <div role="progressbar" aria-label="Synchronisation Garmin" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-valuetext={label} className="h-2 overflow-hidden rounded-full bg-text-muted/15">
        <div className={`h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none ${failed || partial ? 'bg-neon-gold' : finished ? 'bg-success-green' : 'bg-neon-cyan'}`} style={{ width: `${percent}%` }} />
      </div>
      {isPending && <div className="text-xs text-text-muted space-y-1">
        {progress?.total != null && <p>{progress.completed} / {progress.total} activités traitées</p>}
        {progress?.activity_name && <p className="truncate text-text-primary">{progress.activity_name}</p>}
        <p>{stage === 'fetching' ? 'Recherche dans la période sélectionnée…' : stage === 'fit' ? 'Les fichiers FIT ajoutent les tours, les zones cardiaques et les données détaillées.' : 'Garde cette page ouverte pendant la synchronisation.'}</p>
      </div>}
      {!isPending && result && <p className="text-xs text-text-secondary">
        {result.activities_synced} importées · {result.activities_merged} fusionnées · {result.activities_skipped} déjà présentes
      </p>}
      {error && <p role="alert" className="text-xs text-danger-red">{error.message}</p>}
      {!isPending && result && result.errors.length > 0 && <details className="text-xs text-danger-red">
        <summary className="cursor-pointer">{result.errors.length} erreur(s) à consulter</summary>
        <ul className="mt-2 space-y-1 break-words">{result.errors.map((message, index) => <li key={index}>{message}</li>)}</ul>
      </details>}
    </div>
  );
}
