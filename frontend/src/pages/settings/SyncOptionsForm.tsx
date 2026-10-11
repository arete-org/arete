import { useState } from 'react';
import { Button } from '@/components/ui';
import { toLocalISODate } from '@/lib/dates';
import type { SyncOptions } from '@/lib/garminSync';

const COMPACT_INPUT =
  'w-full bg-shadow border border-text-muted/30 rounded px-2 py-1 text-text-primary font-sans';

export function SyncOptionsForm({
  onSync,
  isLoading,
}: {
  onSync: (options: SyncOptions) => void;
  isLoading: boolean;
}) {
  const [days, setDays] = useState(30);
  const [downloadFit, setDownloadFit] = useState(true);
  const [maxActivities, setMaxActivities] = useState(50);

  const handleSync = () => {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    onSync({
      start_date: toLocalISODate(startDate),
      download_fit: downloadFit,
      max_activities: maxActivities,
    });
  };

  return (
    <form className="p-3 rounded border border-text-muted/20" onSubmit={(event) => { event.preventDefault(); handleSync(); }}>
      <fieldset disabled={isLoading}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div>
            <label htmlFor="garminSyncPeriod" className="text-xs text-text-muted font-sans block mb-1">Période</label>
            <select id="garminSyncPeriod" value={days} onChange={(e) => setDays(Number(e.target.value))} className={COMPACT_INPUT}>
              <option value={7}>7 derniers jours</option>
              <option value={30}>30 derniers jours</option>
              <option value={90}>90 derniers jours</option>
              <option value={365}>12 derniers mois</option>
            </select>
          </div>
          <div>
            <label htmlFor="garminSyncMax" className="text-xs text-text-muted font-sans block mb-1">Activités maximum</label>
            <input
              id="garminSyncMax"
              type="number"
              min={1}
              max={200}
              required
              value={maxActivities}
              onChange={(e) => setMaxActivities(Number(e.target.value))}
              className={COMPACT_INPUT}
            />
          </div>
          <div className="sm:col-span-2 flex items-center gap-2">
            <input
              type="checkbox"
              id="systemDownloadFit"
              checked={downloadFit}
              onChange={(e) => setDownloadFit(e.target.checked)}
              className="accent-neon-cyan"
            />
            <label htmlFor="systemDownloadFit" className="text-xs text-text-muted font-sans">
              Télécharger les fichiers FIT
            </label>
          </div>
        </div>
        <Button type="submit" fullWidth className="mt-3" disabled={isLoading}>
          {isLoading ? 'SYNCHRONISATION EN COURS' : 'SYNCHRONISER LES ACTIVITÉS'}
        </Button>
      </fieldset>
    </form>
  );
}
