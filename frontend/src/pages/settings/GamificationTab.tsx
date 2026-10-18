import { useMutation, useQueryClient } from '@tanstack/react-query';
import { gameApi, useGamePreference } from '@/lib/gamification';
import { Button } from '@/components/ui';
import { readableError } from '@/lib/utils';

export function GamificationTab() {
  const preference = useGamePreference();
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: gameApi.toggle,
    onSuccess: (value) => {
      client.setQueryData(['game-preference'], value);
      client.invalidateQueries({ queryKey: ['game'] });
      // Notify other tabs without mirroring authoritative account state locally.
      const channel =
        typeof BroadcastChannel === 'undefined'
          ? null
          : new BroadcastChannel('arete-preferences');
      channel?.postMessage('refresh');
      channel?.close();
    },
  });
  if (preference.isPending) return <p role="status">Chargement…</p>;
  if (preference.isError)
    return (
      <p role="alert">
        Réglage indisponible.{' '}
        <button onClick={() => preference.refetch()}>Réessayer</button>
      </p>
    );
  const p = preference.data;
  return (
    <section className="space-y-5">
      <h2 className="text-lg font-bold">Profil RPG & Chiron</h2>
      <p className="text-sm text-text-secondary">
        Un personnage, des succès et des Éclats pour collectionner des tenues.
        L’expérience inclut Chiron et les pièces jointes dans le message.
      </p>
      <Button
        role="switch"
        aria-checked={p.opted_in}
        disabled={save.isPending || (!p.available && !p.opted_in)}
        onClick={() =>
          save.mutate({ enabled: !p.opted_in, version: p.version })
        }
      >
        {save.isPending
          ? 'Enregistrement…'
          : p.opted_in
            ? 'Désactiver la gamification'
            : 'Activer la gamification'}
      </Button>
      {!p.available && (
        <p role="status" className="text-warning-orange text-sm">
          Indisponible sur ce déploiement.
        </p>
      )}
      {save.error && (
        <p role="alert" className="text-danger-red text-sm">
          {readableError(save.error)}{' '}
          <button className="underline" onClick={() => preference.refetch()}>
            Actualiser
          </button>
        </p>
      )}
      <p className="text-sm text-text-muted">
        Désactivé par défaut. L’activation commence à zéro, sans rétrocrédit.
        Une pause conserve tes XP, tes Éclats et tes tenues ; les séances
        enregistrées pendant la désactivation ne rapportent pas de récompense.
      </p>
      <div className="border-t border-text-muted/20 pt-4 text-sm text-text-secondary space-y-2">
        <p>
          50 XP + 10 Éclats par séance, six séances créditées maximum par
          semaine.
        </p>
        <p>
          Objectif hebdomadaire respecté : +200 XP et +40 Éclats. Un repos
          prescrit compte dans l’objectif adapté.
        </p>
        <p>
          Aucun bonus lié au poids, aux calories ou à la zone 5. Les tenues sont
          cosmétiques.
        </p>
      </div>
    </section>
  );
}
