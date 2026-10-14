import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/** Runs the sign-out routine; stays busy until the page reloads, says so when it fails. */
export function SignOutButton({ signOut }: { signOut: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleClick = () => {
    setPending(true);
    setFailed(false);
    signOut().catch(() => {
      setPending(false);
      setFailed(true);
    });
  };

  return (
    <div>
      <Button variant="outline" onClick={handleClick} loading={pending}>
        {!pending && <LogOut className="size-4" />}
        Se déconnecter
      </Button>
      {failed && (
        <p role="alert" className="mt-2 text-xs font-sans text-danger-red">
          Déconnexion impossible. Réessaie.
        </p>
      )}
    </div>
  );
}
