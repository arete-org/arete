import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { garminApi } from '@/lib/api';

/** A cached status read, never a sync or a model request. */
export function SourceStatus() {
  const query = useQuery({ queryKey: ['syncStatus'], queryFn: garminApi.getSyncStatus, retry: false, staleTime: 60_000 });
  const status = query.data;
  const checked = status?.freshness?.activities_checked_at ?? status?.last_sync;
  const partial = status?.freshness?.complete === false || Boolean(status?.freshness?.errors?.length);
  return <aside aria-label="Sources de mes données" className="ui-inset flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs text-ink-secondary">
    <p>{query.isPending ? 'Vérification des sources…' : query.isError ? 'État des sources indisponible.' : !status?.garmin_authenticated ? 'Garmin non connecté · tes saisies et imports restent disponibles.' : partial ? 'Garmin · synchronisation incomplète, données enregistrées conservées.' : checked ? `Garmin · dernière vérification ${new Date(checked).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}` : 'Garmin connecté · aucune synchronisation confirmée.'}</p>
    <Link className="min-h-11 inline-flex items-center text-accent underline" to="/settings?tab=connections">Gérer les connexions</Link>
  </aside>;
}
