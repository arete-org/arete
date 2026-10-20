import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { ErrorState, LoadingState } from '@/components';
import { Button, Panel } from '@/components/ui';
import { useAuthState } from '@/components/auth/authState';
import { adminApi, ApiError, type AccountRole, type AdminAccount } from '@/lib/api';
import { qk } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { ProductKpisPanel } from './ProductKpisPanel';
import { useCoachName } from '@/lib/coachName';

/** The owner's athlete: nobody deactivates it. */
const OWNER_ATHLETE_ID = 1;

const COLUMNS = ['COMPTE', 'RÔLE', 'ÉTAT', 'DERNIÈRE ACTIVITÉ', 'DERNIÈRE SYNCHRO', 'SYNCHRO AUTO', 'ACTIONS'];

const DATE_FORMAT = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const when = (iso: string | null) => (iso ? DATE_FORMAT.format(new Date(iso)) : 'jamais');

function roleLabel(account: AdminAccount): string {
  if (account.is_owner) return 'Propriétaire';
  return account.role === 'admin' ? 'Admin' : 'Athlète';
}

/** The automatic sync's lease: none, held by a running sync, or left behind past its deadline.
 *  Only a lease left behind can be released: releasing a running one would start a second run. */
function leaseLabel(account: AdminAccount): string {
  if (!account.sync_lease_until) return '—';
  return account.lease_stuck ? `Bloquée depuis le ${when(account.sync_lease_until)}` : 'En cours';
}

const refusal = (error: Error) =>
  error instanceof ApiError ? (error.detail ?? 'Action impossible.') : 'Action impossible.';

function FeatureFlagsPanel() {
  const coach = useCoachName();
  const queryClient = useQueryClient();
  const flags = useQuery({ queryKey: qk.adminFeatureFlags, queryFn: adminApi.featureFlags, retry: false });
  const update = useMutation({
    mutationFn: adminApi.setFeatureFlags,
    onSuccess: (saved) => queryClient.setQueryData(qk.adminFeatureFlags, saved),
  });

  const attention = useMutation({ mutationFn: adminApi.setCoachingAttention, onSuccess: saved => queryClient.setQueryData(qk.adminFeatureFlags, saved) });
  return (
    <Panel variant="inset" className="space-y-3">
      <h2 className="text-lg font-sans text-text-primary">Fonctionnalités expérimentales</h2>
      {flags.isPending ? (
        <LoadingState message="Chargement des options…" />
      ) : flags.isError ? (
        <ErrorState message="Options indisponibles" onRetry={() => void flags.refetch()} />
      ) : (
        <>
          <label className="flex items-start gap-3 text-sm text-text-secondary">
            <input
              type="checkbox"
              className="accent-neon-cyan mt-0.5"
              checked={flags.data.glm_flash}
              disabled={update.isPending || (!flags.data.glm_flash_available && !flags.data.glm_flash)}
              onChange={(event) => update.mutate(event.target.checked)}
              aria-describedby="glm-flash-description"
            />
            Coach GLM Flash (payant)
          </label>
          <p id="glm-flash-description" className="text-xs text-text-muted">
            Active GLM 5.3 Flash pour tous les athlètes : chat, briefings et bilans.
            Plafond : 0,15 $ en entrée et 0,50 $ en sortie par million de tokens.
            Le changement s’applique aux prochaines demandes ; les réponses en cours continuent.
            Désactiver rétablit le modèle configuré sur le serveur.
          </p>
          <label className="flex min-h-11 items-center gap-3 text-sm text-text-secondary">
            <input type="checkbox" checked={flags.data.coaching_attention ?? false} disabled={attention.isPending} onChange={event => attention.mutate(event.target.checked)} />
            Coordination proactive de {coach}
          </label>
          <p className="text-xs text-text-muted">Active le plafond quotidien et la déduplication des questions pour les prochains envois. Désactivé : observation des priorités, comportement d’envoi existant.</p>
          {attention.error && <p role="alert" className="text-xs text-danger-red">{refusal(attention.error)}</p>}
          {!flags.data.glm_flash_available && (
            <p className="text-xs text-warning-orange">OpenRouter et sa clé API doivent être configurés sur le serveur.</p>
          )}
        </>
      )}
      {update.isPending && <p role="status" className="text-xs text-text-muted">Enregistrement…</p>}
      {update.isSuccess && <p role="status" className="text-xs text-success-green">Option enregistrée.</p>}
      {update.isError && <p role="alert" className="text-xs text-danger-red">{refusal(update.error)}</p>}
    </Panel>
  );
}

/**
 * Every athlete and login of the instance, for admins. The buttons mirror the
 * server's rules; the server still enforces them, and its refusal is shown.
 */
export function AdminTab() {
  const queryClient = useQueryClient();
  const { isOwner } = useAuthState();
  const accounts = useQuery({ queryKey: qk.adminAccounts, queryFn: adminApi.accounts, retry: false });
  // The row whose deactivation waits for its confirmation.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ role: 'status' | 'alert'; text: string } | null>(null);

  const succeeded = (text: string) => {
    setNotice({ role: 'status', text });
    void queryClient.invalidateQueries({ queryKey: qk.adminAccounts });
  };
  const failed = (error: Error) => setNotice({ role: 'alert', text: refusal(error) });

  const deactivate = useMutation({
    mutationFn: adminApi.deactivate,
    onSuccess: () => succeeded('Athlète désactivé.'),
    onError: failed,
    onSettled: () => setConfirming(null),
  });
  const reactivate = useMutation({
    mutationFn: adminApi.reactivate,
    onSuccess: () => succeeded('Athlète réactivé.'),
    onError: failed,
  });
  const releaseLease = useMutation({
    mutationFn: adminApi.releaseLease,
    onSuccess: ({ released }) =>
      succeeded(
        released
          ? 'Synchro libérée : elle sera relancée à la prochaine exécution.'
          : 'Aucune synchro à libérer.'
      ),
    onError: failed,
  });
  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: number; role: AccountRole }) => adminApi.setRole(userId, role),
    onSuccess: () => succeeded('Rôle mis à jour.'),
    onError: failed,
  });
  const busy = deactivate.isPending || reactivate.isPending || releaseLease.isPending || setRole.isPending;

  // Only the owner may deactivate an athlete one of whose logins is an admin.
  const adminAthletes = new Set(accounts.data?.filter((a) => a.role === 'admin').map((a) => a.athlete_id));
  const canDeactivate = (account: AdminAccount) =>
    account.athlete_id !== OWNER_ATHLETE_ID && (isOwner || !adminAthletes.has(account.athlete_id));

  return (
    <div className="space-y-6">
      <FeatureFlagsPanel />
      <ProductKpisPanel />
      <div className="flex justify-between items-center gap-4">
        <h2 className="text-lg font-sans text-text-primary">Comptes et athlètes</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void accounts.refetch()}
          className="text-text-secondary hover:border-neon-cyan/50 hover:text-neon-cyan"
        >
          <RefreshCw className="w-3 h-3" />
          Actualiser
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        Chaque compte connecté possède son athlète. Désactiver un athlète ferme ses connexions et masque ses
        données ; réactiver les rétablit.
      </p>
      {notice && (
        <p
          role={notice.role}
          className={cn('text-xs font-sans', notice.role === 'alert' ? 'text-danger-red' : 'text-success-green')}
        >
          {notice.text}
        </p>
      )}

      {accounts.isPending ? (
        <LoadingState message="Chargement des comptes…" />
      ) : accounts.isError ? (
        <ErrorState message="Comptes indisponibles" onRetry={() => void accounts.refetch()} />
      ) : (
        <Panel variant="inset" className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="font-sans text-[11px] tracking-wider text-text-muted">
                {COLUMNS.map((column) => (
                  <th key={column} scope="col" className="pb-2 pr-4 font-normal whitespace-nowrap">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {accounts.data.map((account) => {
                const key = `${account.athlete_id}-${account.user_id}`;
                const userId = account.user_id;
                return (
                  <tr key={key} className="border-t border-text-muted/10 align-top">
                    <td className="py-3 pr-4">
                      {userId === null ? (
                        <span className="text-text-muted">Aucun compte (athlète {account.athlete_id})</span>
                      ) : (
                        <>
                          <div className="font-sans text-text-primary whitespace-nowrap">{account.email}</div>
                          {account.name && <div className="text-text-muted">{account.name}</div>}
                        </>
                      )}
                    </td>
                    <td className="py-3 pr-4 whitespace-nowrap text-text-secondary">{roleLabel(account)}</td>
                    {/* This cell and Synchro auto wrap after "… le", never inside the date. */}
                    <td
                      className={cn(
                        'py-3 pr-4 min-w-[8.5rem]',
                        account.deactivated_at ? 'text-danger-red' : 'text-success-green'
                      )}
                    >
                      {account.deactivated_at ? `Désactivé le ${when(account.deactivated_at)}` : 'Actif'}
                    </td>
                    <td className="py-3 pr-4 whitespace-nowrap text-text-secondary">{when(account.last_seen_at)}</td>
                    <td className="py-3 pr-4 whitespace-nowrap text-text-secondary">{when(account.last_sync_at)}</td>
                    <td
                      className={cn(
                        'py-3 pr-4 min-w-[8.5rem]',
                        account.lease_stuck ? 'text-warning-orange' : 'text-text-secondary'
                      )}
                    >
                      {leaseLabel(account)}
                    </td>
                    <td className="py-3">
                      <div className="flex flex-col items-start gap-2 whitespace-nowrap">
                        {account.deactivated_at ? (
                          <Button
                            size="sm"
                            variant="green"
                            disabled={busy}
                            onClick={() => reactivate.mutate(account.athlete_id)}
                          >
                            Réactiver
                          </Button>
                        ) : (
                          canDeactivate(account) &&
                          (confirming === key ? (
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="danger"
                                strong
                                loading={deactivate.isPending}
                                disabled={busy}
                                onClick={() => deactivate.mutate(account.athlete_id)}
                              >
                                Confirmer
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={deactivate.isPending}
                                onClick={() => setConfirming(null)}
                              >
                                Annuler
                              </Button>
                            </div>
                          ) : (
                            <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirming(key)}>
                              Désactiver
                            </Button>
                          ))
                        )}
                        {account.lease_stuck && (
                          <div className="space-y-1">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => releaseLease.mutate(account.athlete_id)}
                            >
                              Libérer la synchro
                            </Button>
                            <p className="max-w-48 whitespace-normal text-[11px] text-text-muted">
                              Vérifie d'abord les effets de la dernière exécution.
                            </p>
                          </div>
                        )}
                        {isOwner && userId !== null && !account.is_owner && (
                          <Button
                            size="sm"
                            variant="purple"
                            disabled={busy}
                            onClick={() =>
                              setRole.mutate({ userId, role: account.role === 'admin' ? 'athlete' : 'admin' })
                            }
                          >
                            {account.role === 'admin' ? 'Retirer admin' : 'Nommer admin'}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
