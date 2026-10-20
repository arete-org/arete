import { useState } from 'react';
import { Button, Input, Select } from '@/components/ui';
import { toLocalISODate } from '@/lib/dates';
import type { SyncOptions } from '@/lib/garminSync';

export function SyncOptionsForm({
  onSync,
  isLoading,
}: {
  onSync: (options: SyncOptions) => void;
  isLoading: boolean;
}) {
  const [period, setPeriod] = useState('30');
  const [downloadFit, setDownloadFit] = useState(true);
  const [maxActivities, setMaxActivities] = useState(50);

  const handleSync = () => {
    if (period === 'all') {
      onSync({ full_history: true, download_fit: downloadFit });
      return;
    }
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - Number(period));
    onSync({
      start_date: toLocalISODate(startDate),
      download_fit: downloadFit,
      max_activities: maxActivities,
    });
  };

  return (
    <form className="ui-inset p-4 font-sans" onSubmit={(event) => { event.preventDefault(); handleSync(); }}>
      <fieldset disabled={isLoading}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div>
            <label htmlFor="garminSyncPeriod" className="text-xs text-text-muted font-sans block mb-1">Période</label>
            <Select id="garminSyncPeriod" value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value={7}>7 derniers jours</option>
              <option value={30}>30 derniers jours</option>
              <option value={90}>90 derniers jours</option>
              <option value={365}>12 derniers mois</option>
              <option value="all">Tout l’historique</option>
            </Select>
          </div>
          {period !== 'all' && <div>
            <label htmlFor="garminSyncMax" className="text-xs text-text-muted font-sans block mb-1">Activités maximum</label>
            <Input
              id="garminSyncMax"
              type="number"
              min={1}
              max={200}
              required
              value={maxActivities}
              onChange={(e) => setMaxActivities(Number(e.target.value))}
            />
          </div>}
          <p className="sm:col-span-2 text-xs text-text-muted">
            {period === 'all'
              ? 'Un seul lancement importe tout l’historique. Les activités déjà présentes sont ignorées. Garde cette page ouverte ; les fichiers FIT peuvent allonger l’import.'
              : `Chaque lancement traite au maximum ${maxActivities} activités, les plus récentes de la période, y compris celles déjà importées. Choisis « Tout l’historique » pour tout importer automatiquement.`}
          </p>
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
        <Button type="submit" strong fullWidth className="mt-3" disabled={isLoading}>
          {isLoading ? 'Synchronisation en cours' : 'Synchroniser les activités'}
        </Button>
      </fieldset>
    </form>
  );
}
