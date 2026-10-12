import { useEffect, useState } from 'react';
import { Bell, Share, SquarePlus, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import {
  dismissInstall,
  installOffer,
  onInstallChange,
  promptInstall,
  recordVisit,
  type InstallOffer,
} from '@/lib/install';

const IOS_STEPS = [
  { icon: Share, text: 'Touche le bouton Partager de Safari, en bas de l’écran.' },
  { icon: SquarePlus, text: 'Choisis « Sur l’écran d’accueil », puis « Ajouter ».' },
  { icon: Bell, text: 'Ouvre Arete depuis l’écran d’accueil et active les notifications.' },
];

/** The three iOS steps; iOS has no install API, so the athlete does it by hand. */
export function IosInstallSteps() {
  return (
    <ol className="space-y-2" aria-label="Installer Arete sur iPhone">
      {IOS_STEPS.map(({ icon: Icon, text }, index) => (
        <li key={text} className="flex items-start gap-3 text-sm text-text-secondary">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan">
            <Icon className="size-4" aria-hidden />
          </span>
          <span>
            <span className="text-text-muted">{index + 1}. </span>
            {text}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Invitation to add Arete to the home screen, from the second day of use:
 * Chrome's own prompt on Android, the guide on iOS. Dismissal is remembered.
 */
export function InstallPrompt() {
  const [visits] = useState(() => recordVisit());
  const [offer, setOffer] = useState<InstallOffer>(() => installOffer(visits));
  useEffect(() => onInstallChange(() => setOffer(installOffer(visits))), [visits]);

  if (!offer) return null;
  return (
    <aside
      role="region"
      aria-label="Installer Arete"
      className="glass-panel fixed inset-x-3 bottom-20 z-40 p-4 md:inset-x-auto md:bottom-4 md:right-4 md:w-96 animate-scale-in"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="font-sans text-sm text-text-primary">Installe Arete sur ton écran d’accueil</p>
          <p className="text-xs text-text-muted">
            Le briefing du matin, le retour du coach après chaque séance et le bilan de la semaine
            arrivent en notification.
          </p>
        </div>
        <button
          type="button"
          onClick={dismissInstall}
          aria-label="Ne plus proposer"
          className="rounded p-1 hover:bg-text-muted/20"
        >
          <X className="size-4 text-text-muted" />
        </button>
      </div>
      {offer === 'ios' ? (
        <IosInstallSteps />
      ) : (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void promptInstall()}>
            Installer
          </Button>
          <Button size="sm" variant="ghost" onClick={dismissInstall}>
            Plus tard
          </Button>
        </div>
      )}
    </aside>
  );
}
