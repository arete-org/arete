import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { SystemAlert } from '@/components';
import { useAuthState } from '@/components/auth/authState';
import { Button, Field, Input, Panel } from '@/components/ui';
import { forgetThreads } from '@/lib/agentThreads';
import { ApiError, authApi } from '@/lib/api';
import { clearDraft } from '@/lib/onboarding';

/** What the athlete types; the server checks the same word (api/auth.py). */
export const DELETE_CONFIRMATION = 'SUPPRIMER';

/** Clerk refused once the data was gone: nothing is left to retry from here. */
const LOGIN_LEFT = 502;

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.detail) return error.detail;
  return 'Suppression impossible, réessaie dans un instant.';
}

/** Settings → Données: erase the account, after the export offered above it. */
export function AccountDeletionPanel() {
  const auth = useAuthState();
  const [typed, setTyped] = useState('');

  // This browser's copies go too: conversations, drafts, then the session's caches.
  const leave = async () => {
    if (auth.athleteId !== null) {
      forgetThreads(auth.athleteId);
      clearDraft(auth.athleteId);
    }
    await auth.signOut();
  };

  const deletion = useMutation({
    mutationFn: () => authApi.deleteMe(typed),
    onSuccess: leave,
  });
  const loginLeft = deletion.error instanceof ApiError && deletion.error.status === LOGIN_LEFT;

  // Without sign-in there is no account to delete: the instance is its owner's.
  if (!auth.enabled) return null;

  return (
    <Panel variant="inset" title="SUPPRIMER MON COMPTE">
      <div className="space-y-4">
        <p className="text-sm text-text-secondary font-sans">
          La suppression est immédiate et définitive : séances, santé, plans, journal du coach, documents,
          notifications et connexions sont effacés, puis ton identifiant de connexion. Rien ne pourra être récupéré.
          Exporte d’abord tes données ci-dessus si tu veux les garder.
        </p>
        <p className="text-xs text-text-muted font-sans">
          Les sauvegardes automatiques de la base, prises avant chaque mise à jour du serveur, peuvent encore contenir
          tes données jusqu’à leur remplacement : seules les deux plus récentes sont conservées.
        </p>

        <Field label={`Tape ${DELETE_CONFIRMATION} pour confirmer`} gap="sm">
          <Input
            aria-label={`Tape ${DELETE_CONFIRMATION} pour confirmer`}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            disabled={deletion.isPending || loginLeft}
            onChange={(e) => setTyped(e.target.value)}
          />
        </Field>

        {deletion.isError && (
          <SystemAlert
            type="error"
            message={errorMessage(deletion.error)}
            onDismiss={loginLeft ? undefined : () => deletion.reset()}
          />
        )}

        {loginLeft ? (
          <Button variant="danger" onClick={() => void leave()}>
            SE DÉCONNECTER
          </Button>
        ) : (
          <Button
            variant="danger"
            strong
            onClick={() => deletion.mutate()}
            loading={deletion.isPending}
            disabled={typed !== DELETE_CONFIRMATION}
          >
            {!deletion.isPending && <Trash2 className="w-4 h-4" />}
            {deletion.isPending ? 'SUPPRESSION…' : 'SUPPRIMER DÉFINITIVEMENT'}
          </Button>
        )}
      </div>
    </Panel>
  );
}
