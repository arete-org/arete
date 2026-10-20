import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { SystemAlert } from '@/components';
import { useAuthState } from '@/components/auth/authState';
import { Button, Field, Input, Panel } from '@/components/ui';
import { forgetThreads } from '@/lib/agentThreads';
import { ACCOUNT_DELETED, ApiError, authApi } from '@/lib/api';
import { endSessionLocally } from '@/lib/auth';
import { clearDraft } from '@/lib/onboarding';

/** What the athlete types; the server checks the same word (api/auth.py). */
export const DELETE_CONFIRMATION = 'SUPPRIMER';

/** Clerk refused once the data was gone: the server erased everything else. */
const LOGIN_LEFT = 502;

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.detail) return error.detail;
  return 'Suppression impossible, réessaie dans un instant.';
}

/** Settings → Données: erase the account, after the export offered above it. */
export function AccountDeletionPanel() {
  const auth = useAuthState();
  const [typed, setTyped] = useState('');
  // Set once the server erased the data: from then on only signing out is left.
  const [erased, setErased] = useState<{ notice: string; tone: 'success' | 'warning'; signOutFailed: boolean } | null>(
    null
  );

  // Clerk may already have revoked the deleted user's session, failing its
  // sign-out: end the session in this browser anyway.
  const leave = () => {
    auth
      .signOut()
      .catch(() => endSessionLocally())
      .catch(() => setErased((current) => current && { ...current, signOutFailed: true }));
  };
  const erasedHere = (notice: string, tone: 'success' | 'warning') => {
    // This browser's copies go too; the coach panel stops saving them (agentThreads).
    if (auth.athleteId !== null) {
      forgetThreads(auth.athleteId);
      clearDraft(auth.athleteId);
    }
    setErased({ notice, tone, signOutFailed: false });
  };

  const deletion = useMutation({
    mutationFn: () => authApi.deleteMe(typed),
    onSuccess: () => {
      erasedHere('Ton compte et tes données sont supprimés. Déconnexion…', 'success');
      leave();
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.status === LOGIN_LEFT) erasedHere(errorMessage(error), 'warning');
      // An earlier attempt erased the account (its answer was lost): done here too.
      if (error.code === ACCOUNT_DELETED) {
        erasedHere('Ton compte et tes données sont supprimés. Déconnexion…', 'success');
        leave();
      }
    },
  });

  // Without sign-in there is no account to delete: the instance is its owner's.
  if (!auth.enabled) return null;

  return (
    <Panel variant="inset" title="Supprimer mon compte">
      {auth.isOwner ? (
        <p className="text-sm text-text-secondary font-sans">
          Le compte propriétaire ne peut pas être supprimé depuis l’application : l’instance resterait sans
          propriétaire. Sa suppression se fait à la main, par l’opérateur de l’instance.
        </p>
      ) : erased ? (
        <div className="space-y-4">
          <SystemAlert type={erased.tone} message={erased.notice} />
          {erased.signOutFailed && (
            <p className="text-sm text-text-secondary font-sans">La déconnexion a échoué : relance-la.</p>
          )}
          <Button variant="danger" onClick={leave}>
            Se déconnecter
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary font-sans">
            La suppression est immédiate et définitive : séances, santé, plans, journal du coach, documents,
            notifications et connexions sont effacés, puis ton identifiant de connexion. Rien ne pourra être récupéré.
            Exporte d’abord tes données ci-dessus si tu veux les garder.
          </p>
          <p className="text-xs text-text-muted font-sans">
            Les sauvegardes automatiques de la base, prises avant chaque mise à jour du serveur, peuvent encore
            contenir tes données jusqu’à leur remplacement : seules les deux plus récentes sont conservées.
          </p>

          <Field label={`Tape ${DELETE_CONFIRMATION} pour confirmer`} gap="sm">
            <Input
              aria-label={`Tape ${DELETE_CONFIRMATION} pour confirmer`}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              disabled={deletion.isPending}
              onChange={(e) => setTyped(e.target.value)}
            />
          </Field>

          {deletion.isError && (
            <SystemAlert type="error" message={errorMessage(deletion.error)} onDismiss={() => deletion.reset()} />
          )}

          <Button
            variant="danger"
            strong
            onClick={() => deletion.mutate()}
            loading={deletion.isPending}
            disabled={typed !== DELETE_CONFIRMATION}
          >
            {!deletion.isPending && <Trash2 className="w-4 h-4" />}
            {deletion.isPending ? 'Suppression…' : 'Supprimer définitivement'}
          </Button>
        </div>
      )}
    </Panel>
  );
}
