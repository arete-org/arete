import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ShieldOff } from 'lucide-react';
import { useAuthState } from '@/components/auth/authState';
import { Button, Panel } from '@/components/ui';
import { ApiError, authApi, type ConsentState } from '@/lib/api';
import { formatConsentDate } from '@/lib/consent';
import { LegalReader } from '@/legal/LegalReader';

/** Settings → À propos: the published texts, the athlete's consent and its withdrawal. */
export function AboutTab() {
  const { consent, setConsent } = useAuthState();
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-sans text-text-primary">À PROPOS</h2>

      <Panel variant="inset" title="TEXTES">
        <div className="space-y-3">
          <LegalReader />
          <p className="text-xs text-text-muted font-sans">
            Brouillons en attente de validation.
            {consent && ` Versions en vigueur : conditions ${consent.terms_version}, confidentialité ${consent.privacy_version}.`}
          </p>
        </div>
      </Panel>

      <Panel variant="inset" title="CONSENTEMENT">
        {consent ? (
          <ConsentStatus consent={consent} onWithdrawn={setConsent} />
        ) : (
          <p className="text-sm text-text-secondary">
            Cette installation fonctionne sans connexion au compte : aucun consentement n’y est demandé.
          </p>
        )}
      </Panel>
    </div>
  );
}

function ConsentStatus({
  consent,
  onWithdrawn,
}: {
  consent: ConsentState;
  onWithdrawn: (consent: ConsentState) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const withdraw = useMutation({
    mutationFn: () => authApi.withdrawConsent(),
    onSuccess: (state) => onWithdrawn(state),
  });
  const latest = consent.latest;

  if (!latest || !consent.current) {
    // The gate shows in place of the app until consent is given: rarely seen here.
    return <p className="text-sm text-text-secondary">Aucun consentement en vigueur.</p>;
  }
  const given = formatConsentDate(latest.consented_at);
  return (
    <div className="space-y-4">
      <ul className="space-y-1 text-sm text-text-secondary">
        <li>
          Conditions d’utilisation et politique de confidentialité acceptées le {given} (versions{' '}
          {latest.terms_version} et {latest.privacy_version}).
        </li>
        <li>Consentement explicite au traitement de tes données de santé donné le {given}.</li>
      </ul>
      {confirming ? (
        <div className="space-y-3">
          <p className="text-sm text-text-primary">
            Retirer ton consentement arrête les synchronisations, le briefing, le message du soir, les automatisations et
            le coach. Tes données sont conservées et restent exportables ; tu pourras redonner ton accord à tout moment.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" strong onClick={() => withdraw.mutate()} loading={withdraw.isPending}>
              CONFIRMER LE RETRAIT
            </Button>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={withdraw.isPending}>
              ANNULER
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="danger" onClick={() => setConfirming(true)}>
          <ShieldOff className="size-4" />
          RETIRER MON CONSENTEMENT
        </Button>
      )}
      {withdraw.isError && (
        <p role="alert" className="text-xs font-sans text-danger-red">
          {withdraw.error instanceof ApiError && withdraw.error.detail
            ? withdraw.error.detail
            : 'Retrait impossible, réessaie dans un instant.'}
        </p>
      )}
    </div>
  );
}
