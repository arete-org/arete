import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, LogOut, Watch } from 'lucide-react';
import { cn, readableError } from '@/lib/utils';
import { garminApi } from '@/lib/api';
import { Button } from '@/components/ui';
import { invalidateWithDashboard } from '@/lib/queryKeys';
import { GoogleCalendarConnection } from './GoogleCalendarConnection';
import { SlackConnection } from './SlackConnection';
import { useGarminSync } from './useGarminSync';
import { GarminSyncProgress } from './GarminSyncProgress';
import { GarminLoginModal } from '@/components/GarminLoginModal';

export function ConnectionsTab() {
  const queryClient = useQueryClient();
  const [showGarminLogin, setShowGarminLogin] = useState(false);
  const [garminResult, setGarminResult] = useState<string | null>(null);

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
    onError: (error: Error) => setGarminResult(readableError(error)),
  });

  const garminConnected = syncStatus?.garmin_authenticated;

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-sans text-text-primary mb-4">Services connectés</h2>

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
              <Button size="sm" disabled={garminSync.isPending || garminLogout.isPending} onClick={() => { setGarminResult(null); garminSync.mutate({ max_activities: 50, download_fit: true }); }}>Synchroniser</Button>
              <Button variant="danger" size="sm" aria-label="Déconnecter Garmin" loading={garminLogout.isPending} disabled={garminSync.isPending} onClick={() => garminLogout.mutate()}><LogOut className="w-3 h-3" /></Button>
            </div>
          ) : (
            <Button size="sm" disabled={garminLoading || garminError} onClick={() => setShowGarminLogin(true)}>Connecter Garmin</Button>
          )}
        </div>

        <GarminSyncProgress progress={garminSync.progress} isPending={garminSync.isPending} result={garminSync.data} error={garminSync.error} />
      </div>
      <GarminLoginModal isOpen={showGarminLogin} onClose={() => setShowGarminLogin(false)} onSuccess={() => {
        setGarminResult('Garmin connecté. Lance la synchronisation pour importer tes activités.');
      }} />
    </div>
  );
}
