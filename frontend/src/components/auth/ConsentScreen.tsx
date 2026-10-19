import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Download, ShieldCheck } from 'lucide-react';
import { AreteWordmark } from '@/components/AreteBrand';
import { Button } from '@/components/ui/Button';
import { ApiError, authApi, type ConsentState } from '@/lib/api';
import { downloadExport, EXPORT_TABLES } from '@/lib/dataExport';
import { formatConsentDate } from '@/lib/consent';
import { LegalReader } from '@/legal/LegalReader';
import { AccountDeletionPanel } from '@/pages/settings/AccountDeletionPanel';
import { GateScreen } from './GateScreen';
import { SignOutButton } from './SignOutButton';

interface ConsentScreenProps {
  consent: ConsentState;
  email: string;
  /** The server's answer once consent is recorded: the app opens. */
  onConsent: (consent: ConsentState) => void;
  signOut: () => Promise<void>;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.detail) return error.detail;
  return fallback;
}

/**
 * Shown in place of the app until the athlete accepts the current terms and
 * privacy policy and, separately, the processing of their health data (GDPR
 * art. 9). The server refuses every other route meanwhile. Nothing is ticked
 * in advance. Every athlete keeps their export and their way out: an existing
 * athlete meets this screen with data already stored.
 */
export function ConsentScreen({ consent, email, onConsent, signOut }: ConsentScreenProps) {
  const [terms, setTerms] = useState(false);
  const [health, setHealth] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // The app's query client lives behind this screen; the deletion needs its own.
  const [deletionClient] = useState(() => new QueryClient());
  const withdrawnAt = consent.latest?.withdrawn_at ?? null;
  const outdated = consent.latest !== null && withdrawnAt === null;

  const accept = () => {
    setPending(true);
    setError(null);
    // The versions of the texts shown (this build's), never the server's: a page
    // older than the server is refused (409) rather than recorded as accepting
    // texts the athlete never read. Loaded with the texts, not with the gate.
    import('@/legal/versions')
      .then(({ LEGAL_VERSIONS }) =>
        authApi.giveConsent({
          terms_version: LEGAL_VERSIONS.terms,
          privacy_version: LEGAL_VERSIONS.privacy,
          terms_accepted: terms,
          health_data: health,
        })
      )
      .then(onConsent, (e: unknown) => {
        setPending(false);
        setError(errorMessage(e, 'Enregistrement impossible, réessaie dans un instant.'));
      });
  };

  const exportData = () => {
    setExporting(true);
    setExportError(null);
    downloadExport({ format: 'zip', tables: EXPORT_TABLES.map((t) => t.id) })
      .catch((e: unknown) => setExportError(errorMessage(e, 'Export impossible, réessaie dans un instant.')))
      .finally(() => setExporting(false));
  };

  return (
    <GateScreen>
      <div className="glass-panel w-full max-w-2xl p-4 sm:p-6 space-y-5 animate-fade-up">
        <h1 className="text-text-primary"><AreteWordmark /></h1>
        <div className="space-y-2 text-sm text-text-primary">
          {withdrawnAt ? (
            <p>
              Tu as retiré ton consentement le {formatConsentDate(withdrawnAt)}. Tes données sont conservées, mais rien
              n’est synchronisé, analysé ni envoyé au coach tant que tu ne l’as pas donné à nouveau.
            </p>
          ) : outdated ? (
            <p>
              Les conditions d’utilisation ou la politique de confidentialité ont changé. Lis la nouvelle version et
              donne à nouveau ton accord pour continuer.
            </p>
          ) : (
            <p>
              Arete traite des données de santé (variabilité cardiaque, sommeil, fréquence cardiaque au repos,
              stress, Body Battery). Tant que tu n’as pas donné ton accord, rien n’est synchronisé, analysé ni envoyé
              au coach. Les données déjà enregistrées sont conservées : tu peux les exporter, ou demander la
              suppression de ton compte.
            </p>
          )}
        </div>

        <LegalReader />

        <div className="space-y-3">
          <ConsentBox checked={terms} onChange={setTerms}>
            J’ai lu et j’accepte les conditions d’utilisation et la politique de confidentialité.
          </ConsentBox>
          <ConsentBox checked={health} onChange={setHealth}>
            Je consens explicitement à ce qu’Arete traite mes données de santé (variabilité cardiaque, sommeil,
            fréquence cardiaque, stress, Body Battery, ressenti du matin) pour suivre et adapter mon entraînement, y
            compris en les transmettant aux modèles d’intelligence artificielle du coach (article 9 du RGPD). Je peux
            retirer ce consentement à tout moment dans Réglages → À propos.
          </ConsentBox>
        </div>

        {error && (
          <p role="alert" className="text-xs font-sans text-danger-red">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-start gap-3">
          <Button variant="cyan" strong onClick={accept} disabled={!terms || !health} loading={pending}>
            {!pending && <ShieldCheck className="size-4" />}
            ACCEPTER ET CONTINUER
          </Button>
          {/* An existing athlete meets this screen with data already stored: the export is always offered. */}
          <Button variant="outline" onClick={exportData} loading={exporting}>
            {!exporting && <Download className="size-4" />}
            Exporter mes données
          </Button>
          <SignOutButton signOut={signOut} />
        </div>
        {exportError && (
          <p role="alert" className="text-xs font-sans text-danger-red">
            {exportError}
          </p>
        )}
        <QueryClientProvider client={deletionClient}>
          <AccountDeletionPanel />
        </QueryClientProvider>
        <p className="text-xs font-sans text-text-muted">
          Connecté en tant que <span className="text-text-secondary">{email}</span>
        </p>
      </div>
    </GateScreen>
  );
}

function ConsentBox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input
        type="checkbox"
        className="accent-neon-cyan mt-1 shrink-0"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="text-sm text-text-secondary">{children}</span>
    </label>
  );
}
