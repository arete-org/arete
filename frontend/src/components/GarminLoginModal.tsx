import { inputClasses } from '@/components/ui/Input';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Modal } from '@/components/ui';
import { authFetch } from '@/lib/auth';
import { invalidateWithDashboard } from '@/lib/queryKeys';
import { readableError } from '@/lib/utils';

interface GarminLoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const FIELD = inputClasses('cyan', 'text-sm');
const LABEL = 'text-xs text-text-muted font-sans uppercase tracking-wider block mb-1';

export function GarminLoginModal({ isOpen, onClose, onSuccess }: GarminLoginModalProps) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [needsMfa, setNeedsMfa] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loginMutation = useMutation({
    mutationFn: async (credentials: { email: string; password: string; mfa_code?: string }) => {
      const res = await authFetch('/api/garmin/sync/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Connexion impossible');
      return data as { needs_mfa?: boolean };
    },
    onSuccess: (data) => {
      if (data.needs_mfa) {
        setPassword('');
        setNeedsMfa(true);
        setError(null);
      } else {
        invalidateWithDashboard(queryClient, ['syncStatus']);
        handleClose();
        onSuccess();
      }
    },
    onError: (err) => setError(readableError(err)),
  });

  const handleClose = () => {
    setEmail('');
    setPassword('');
    setMfaCode('');
    setNeedsMfa(false);
    setShowPassword(false);
    setError(null);
    onClose();
  };

  const handleSubmit = () => {
    setError(null);
    if (needsMfa) loginMutation.mutate({ email: '', password: '', mfa_code: mfaCode });
    else loginMutation.mutate({ email, password });
  };

  const incomplete = needsMfa ? !mfaCode : !email || !password;

  return (
    <Modal open={isOpen} onClose={handleClose} className="max-w-md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!incomplete && !loginMutation.isPending) handleSubmit();
        }}
      >
      <h2 className="text-lg font-sans text-neon-cyan mb-4">
        Garmin Connect — {needsMfa ? 'Vérification en deux étapes' : 'Connexion'}
      </h2>

      {needsMfa ? (
        <>
          <p className="text-sm font-sans text-text-muted mb-6">Saisis le code envoyé sur ton appareil.</p>
          <div>
            <label htmlFor="garmin-mfa" className={LABEL}>Code</label>
            <input
              id="garmin-mfa"
              type="text"
              autoComplete="one-time-code"
              inputMode="numeric"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              className={`${FIELD} border-neon-cyan/30 text-center text-xl tracking-widest`}
              placeholder="000000"
              maxLength={6}
              autoFocus
            />
          </div>
          <div className="mt-4 p-3 bg-neon-purple/10 border border-neon-purple/30 rounded">
            <p className="text-xs font-sans text-neon-purple">
              &gt; Le code arrive dans l'application Garmin Connect ou par e-mail.
            </p>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm font-sans text-text-muted mb-6">Connecte ton compte Garmin pour synchroniser tes activités.</p>
          <div className="space-y-4">
            <div>
              <label htmlFor="garmin-email" className={LABEL}>E-mail</label>
              <input
                id="garmin-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={FIELD}
                placeholder="toi@exemple.fr"
                autoComplete="username"
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="garmin-password" className={LABEL}>Mot de passe</label>
              <input
                id="garmin-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={FIELD}
                placeholder="••••••••"
                autoComplete="current-password"
              />
              <label className="mt-2 flex items-center gap-2 text-xs font-sans text-text-muted cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showPassword}
                  onChange={(e) => setShowPassword(e.target.checked)}
                  className="accent-neon-cyan"
                />
                Afficher le mot de passe
              </label>
            </div>
          </div>
          <div className="mt-4 p-3 bg-warning-orange/10 border border-warning-orange/30 rounded">
            <p className="text-xs font-sans text-warning-orange">
              &gt; Les identifiants ne servent qu'une fois : seuls les jetons de session sont conservés.
            </p>
          </div>
        </>
      )}

      {error && (
        <div className="mt-4 p-3 bg-danger-red/10 border border-danger-red/30 rounded">
          <p className="text-xs font-sans text-danger-red">&gt; {error}</p>
        </div>
      )}

      <div className="mt-6 flex gap-3 justify-end">
        <Button variant="ghost" onClick={handleClose}>
          Annuler
        </Button>
        <Button type="submit" disabled={incomplete} loading={loginMutation.isPending}>
          {loginMutation.isPending ? 'Vérification…' : needsMfa ? 'Vérifier' : 'Connecter'}
        </Button>
      </div>
      </form>
    </Modal>
  );
}
