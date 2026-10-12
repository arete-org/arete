import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, Cloud, Database, LogOut, RefreshCw, Server, XCircle } from 'lucide-react';
import { GarminLoginModal, SystemAlert } from '@/components';
import { Button, Panel } from '@/components/ui';
import { garminApi, garminHealthApi, healthApi } from '@/lib/api';
import { StatusRow } from './StatusRow';
import { SyncOptionsForm } from './SyncOptionsForm';
import { useGarminSync } from './useGarminSync';
import { GarminSyncProgress } from './GarminSyncProgress';
import { toLocalISODate } from '@/lib/dates';

type Alert = { type: 'success' | 'error' | 'info'; message: string };

export function SystemTab() {
  const queryClient = useQueryClient();
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [alert, setAlert] = useState<Alert | null>(null);

  const { data: health, isLoading: healthLoading, refetch: refetchHealth } = useQuery({
    queryKey: ['health'],
    queryFn: healthApi.check,
    retry: false,
  });

  const { data: syncStatus, isLoading: syncLoading, refetch: refetchSync } = useQuery({
    queryKey: ['syncStatus'],
    queryFn: garminApi.getSyncStatus,
    retry: false,
  });

  const { data: healthStatus } = useQuery({
    queryKey: ['garminHealthStatus'],
    queryFn: garminHealthApi.getStatus,
    retry: false,
  });

  const logoutMutation = useMutation({
    mutationFn: garminApi.logout,
    onSuccess: () => {
      setAlert({ type: 'success', message: 'DÉCONNECTÉ DE GARMIN' });
      queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
    },
  });

  const thresholdMutation = useMutation({
    mutationFn: garminApi.refreshThreshold,
    onSuccess: (result) => {
      setAlert(
        result.updated
          ? {
              type: 'success',
              message: `SEUIL GARMIN : ${result.lthr} BPM (TEST DU ${result.measured_on})`,
            }
          : { type: 'info', message: 'AUCUN TEST GARMIN PLUS RÉCENT' }
      );
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error) => setAlert({ type: 'error', message: `LECTURE DU SEUIL IMPOSSIBLE : ${error}` }),
  });

  const zonesMutation = useMutation({
    mutationFn: garminApi.recomputeZones,
    onSuccess: (result) => {
      const basis =
        result.model.basis === 'lthr'
          ? `seuil ${result.model.reference} bpm`
          : `FC max ${result.model.reference} bpm`;
      setAlert({
        type: 'success',
        message: `ZONES RECALCULÉES SUR ${basis.toUpperCase()} · ${result.from_fit} SÉANCES FIT, ${result.from_laps} PAR TOURS`,
      });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
    },
    onError: (error) => setAlert({ type: 'error', message: `RECALCUL IMPOSSIBLE : ${error}` }),
  });

  const syncMutation = useGarminSync();

  const healthSyncMutation = useMutation({
    mutationFn: () => {
      const end = new Date();
      const start = new Date(end.getTime() - 7 * 86400000);
      return garminHealthApi.sync(toLocalISODate(start), toLocalISODate(end));
    },
    onSuccess: (result) => {
      setAlert({
        type: result.days_failed ? 'error' : 'success',
        message: `SANTÉ : ${result.days_synced} JOURS SYNCHRONISÉS${result.days_failed ? `, ${result.days_failed} EN ÉCHEC` : ''}`,
      });
      queryClient.invalidateQueries({ queryKey: ['garminHealthStatus'] });
      queryClient.invalidateQueries({ queryKey: ['garmin-health'] });
    },
    onError: (error) => setAlert({ type: 'error', message: `SYNCHRO SANTÉ IMPOSSIBLE : ${error}` }),
  });

  const handleRefresh = () => {
    refetchHealth();
    refetchSync();
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-sans text-text-primary">SYSTÈME</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          className="text-text-secondary hover:border-neon-cyan/50 hover:text-neon-cyan"
        >
          <RefreshCw className="w-3 h-3" />
          ACTUALISER
        </Button>
      </div>

      {alert && (
        <div className="animate-fade-down">
          <SystemAlert type={alert.type} message={alert.message} onDismiss={() => setAlert(null)} />
        </div>
      )}

      <Panel variant="inset" title="ÉTAT">
        <div className="space-y-2">
          <StatusRow
            icon={<Server className="w-4 h-4" />}
            label="API"
            status={health?.status === 'ok' ? 'online' : healthLoading ? 'loading' : 'offline'}
          />
          <StatusRow
            icon={<Database className="w-4 h-4" />}
            label="DuckDB"
            status={health?.database === 'connected' ? 'online' : 'offline'}
          />
          <StatusRow
            icon={<Cloud className="w-4 h-4" />}
            label="Garmin Connect"
            status={syncStatus?.garmin_authenticated ? 'online' : syncLoading ? 'loading' : 'offline'}
          />
        </div>
      </Panel>

      <Panel variant="inset" title="SYNCHRONISATION GARMIN">
        {syncStatus?.garmin_authenticated ? (
          <div className="space-y-4">
            <div className="ui-inset p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-success-green font-sans flex items-center gap-2">
                    <CheckCircle className="w-4 h-4" />
                    {syncStatus.user_email ? `Connecté en tant que ${syncStatus.user_email}` : 'Connecté'}
                  </div>
                  <div className="text-xs text-text-muted mt-1 font-sans">
                    Dernière sync : {syncStatus.last_sync ? new Date(syncStatus.last_sync).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : 'jamais'}
                    {' · '}
                    Activités : {syncStatus.activities_synced}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => logoutMutation.mutate()}
                    aria-label="Se déconnecter de Garmin"
                    disabled={syncMutation.isPending || logoutMutation.isPending}
                  >
                    <LogOut className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            </div>

            <GarminSyncProgress progress={syncMutation.progress} isPending={syncMutation.isPending} result={syncMutation.data} error={syncMutation.error} />

            <SyncOptionsForm onSync={(options) => syncMutation.mutate(options)} isLoading={syncMutation.isPending} />

            <div className="ui-inset p-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-neon-purple font-sans">Données santé (VFC, sommeil, batterie corporelle)</div>
                <div className="text-xs text-text-muted mt-1 font-sans">
                  {healthStatus?.days_stored
                    ? `${healthStatus.days_stored} jours stockés, dernier le ${healthStatus.last_date}`
                    : 'Aucune donnée santé pour le moment'}
                </div>
              </div>
              <Button
                variant="purple"
                size="sm"
                onClick={() => healthSyncMutation.mutate()}
                loading={healthSyncMutation.isPending}
              >
                {healthSyncMutation.isPending ? 'SYNCHRO…' : 'SYNCHRONISER 7 JOURS'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="p-4 rounded border border-text-muted/30 text-center">
            <XCircle className="w-6 h-6 text-danger-red mx-auto mb-2" />
            <div className="text-sm text-text-muted font-sans">NON CONNECTÉ</div>
            <Button className="mt-3" onClick={() => setShowLoginModal(true)}>
              CONNECTER
            </Button>
          </div>
        )}
      </Panel>

      <Panel variant="inset" title="SEUIL ET ZONES">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-text-muted font-sans">
              Chaque synchro reprend le seuil mesuré par Garmin et l'applique aux séances suivantes.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => thresholdMutation.mutate()}
              loading={thresholdMutation.isPending}
            >
              {thresholdMutation.isPending ? 'LECTURE…' : 'LIRE LE SEUIL'}
            </Button>
          </div>
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-text-muted font-sans">
              Recalcule le temps par zone sur toutes les séances déjà enregistrées, seuil actuel compris.
            </p>
            <Button size="sm" onClick={() => zonesMutation.mutate()} loading={zonesMutation.isPending}>
              {zonesMutation.isPending ? 'CALCUL…' : 'RECALCULER'}
            </Button>
          </div>
        </div>
      </Panel>

      <GarminLoginModal
        isOpen={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        onSuccess={() => {
          setShowLoginModal(false);
          setAlert({ type: 'success', message: 'GARMIN CONNECT AUTHENTIFIÉ' });
          queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
        }}
      />
    </div>
  );
}
