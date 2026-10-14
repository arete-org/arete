import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Check, LogOut, Target, Watch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { garminApi, stravaApi } from '@/lib/api';
import { Button } from '@/components/ui';
import { invalidateAfterSession, invalidateWithDashboard } from '@/lib/queryKeys';
import { GoogleCalendarConnection } from './GoogleCalendarConnection';
import { SlackConnection } from './SlackConnection';
import { useGarminSync } from './useGarminSync';
import { GarminSyncProgress } from './GarminSyncProgress';
import { GarminLoginModal } from '@/components/GarminLoginModal';

export function ConnectionsTab() {
  const queryClient = useQueryClient();
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [showGarminLogin, setShowGarminLogin] = useState(false);
  const [garminResult, setGarminResult] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const { data: syncStatus, isError: garminError, isPending: garminLoading } = useQuery({
    queryKey: ['syncStatus'],
    queryFn: garminApi.getSyncStatus,
    retry: false,
  });

  const garminSync = useGarminSync();
  const garminLogout = useMutation({
    mutationFn: garminApi.logout,
    onSuccess: () => {
      setGarminResult('Garmin déconnecté. Tes séances importées sont conservées.');
      garminSync.reset();
      invalidateWithDashboard(queryClient, ['syncStatus']);
    },
    onError: (error: Error) => setGarminResult(error.message),
  });

  const { data: stravaStatus, isError: stravaError } = useQuery({
    queryKey: ['stravaStatus'],
    queryFn: stravaApi.getStatus,
    retry: false,
  });

  // Coming back from the Strava OAuth redirect: drop only the `strava` flag (the
  // tab stays selected) and refresh the status.
  useEffect(() => {
    if (searchParams.get('strava') === 'connected') {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('strava');
          return next;
        },
        { replace: true }
      );
      queryClient.invalidateQueries({ queryKey: ['stravaStatus'] });
    }
  }, [searchParams, setSearchParams, queryClient]);

  const connectMutation = useMutation({
    mutationFn: stravaApi.getAuthorizeUrl,
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (err) =>
      setSyncResult(`Strava : ${err instanceof Error ? err.message : 'autorisation impossible à lancer'}`),
  });

  const syncMutation = useMutation({
    mutationFn: () => stravaApi.sync(30),
    onSuccess: (result) => {
      setSyncResult(
        `${result.imported} importée(s), ${result.merged} fusionnée(s) avec des séances Garmin, ${result.skipped} ignorée(s)`
      );
      queryClient.invalidateQueries({ queryKey: ['stravaStatus'] });
      invalidateAfterSession(queryClient);
    },
    onError: (err) => setSyncResult(`Échec de la synchro : ${err instanceof Error ? err.message : err}`),
  });

  const disconnectMutation = useMutation({
    mutationFn: stravaApi.disconnect,
    onSuccess: () => {
      setSyncResult(null);
      queryClient.invalidateQueries({ queryKey: ['stravaStatus'] });
    },
    onError: () => setSyncResult('Déconnexion impossible'),
  });

  const garminConnected = syncStatus?.garmin_authenticated;
  const stravaConnected = stravaStatus?.connected ?? false;

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-sans text-text-primary mb-4">SERVICES CONNECTÉS</h2>

      <div className="space-y-3">
        <GoogleCalendarConnection />
        <SlackConnection />
        {/* Garmin */}
        <div
          className={cn(
            'flex flex-wrap items-center gap-4 p-4 rounded bg-abyss/50 border',
            garminConnected ? 'border-success-green/30' : 'border-text-muted/20'
          )}
        >
          <Watch className="w-6 h-6 text-text-muted" />
          <div className="flex-1">
            <div className="font-sans text-sm text-text-primary">Garmin Connect</div>
            {syncStatus?.user_email && (
              <div className="text-xs text-neon-cyan">{syncStatus.user_email}</div>
            )}
            {garminError && <p className="text-xs text-danger-red" role="alert">État Garmin indisponible.</p>}
            {garminResult && <p className="text-xs text-text-muted" role="status">{garminResult}</p>}
          </div>
          {garminConnected ? (
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <span className="flex items-center gap-1 text-xs text-success-green"><Check className="w-4 h-4" />Connecté</span>
              <Button size="sm" disabled={garminSync.isPending || garminLogout.isPending} onClick={() => { setGarminResult(null); garminSync.mutate({ max_activities: 50, download_fit: true }); }}>SYNCHRONISER</Button>
              <Button variant="danger" size="sm" aria-label="Déconnecter Garmin" loading={garminLogout.isPending} disabled={garminSync.isPending} onClick={() => garminLogout.mutate()}><LogOut className="w-3 h-3" /></Button>
            </div>
          ) : (
            <Button size="sm" disabled={garminLoading || garminError} onClick={() => setShowGarminLogin(true)}>CONNECTER GARMIN</Button>
          )}
        </div>

        <GarminSyncProgress progress={garminSync.progress} isPending={garminSync.isPending} result={garminSync.data} error={garminSync.error} />

        {/* Strava */}
        <div
          className={cn(
            'flex items-center gap-4 p-4 rounded bg-abyss/50 border',
            stravaConnected ? 'border-success-green/30' : 'border-text-muted/20'
          )}
        >
          <Target className="w-6 h-6 text-text-muted" />
          <div className="flex-1">
            <div className="font-sans text-sm text-text-primary">Strava</div>
            {stravaConnected && stravaStatus?.athlete_name && (
              <div className="text-xs text-strava">{stravaStatus.athlete_name}</div>
            )}
            {stravaError && (
              <div className="text-xs text-danger-red mt-1 font-sans">État indisponible</div>
            )}
            {syncResult && (
              <div className="text-xs text-text-muted mt-1 font-sans">{syncResult}</div>
            )}
          </div>
          {stravaConnected ? (
            <div className="flex items-center gap-2">
              <Button
                variant="strava"
                size="sm"
                loading={syncMutation.isPending}
                onClick={() => {
                  setSyncResult(null);
                  syncMutation.mutate();
                }}
              >
                {syncMutation.isPending ? 'SYNCHRO…' : 'SYNCHRONISER'}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => disconnectMutation.mutate()}
                loading={disconnectMutation.isPending}
                aria-label="Déconnecter Strava"
              >
                <LogOut className="w-3 h-3" />
              </Button>
            </div>
          ) : (
            <Button
              variant="strava"
              size="sm"
              onClick={() => connectMutation.mutate()}
              loading={connectMutation.isPending}
            >
              CONNECTER
            </Button>
          )}
        </div>
      </div>
      <GarminLoginModal isOpen={showGarminLogin} onClose={() => setShowGarminLogin(false)} onSuccess={() => {
        setGarminResult('Garmin connecté. Lance la synchronisation pour importer tes activités.');
      }} />
    </div>
  );
}
