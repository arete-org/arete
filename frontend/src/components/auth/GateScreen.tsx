import type { ReactNode } from 'react';
import { AretePresence } from '@/components/AreteBrand';

/** Full-page frame for what the gate shows in place of the app. */
export function GateScreen({ children }: { children: ReactNode }) {
  return (
    <div className="gate-screen min-h-screen bg-void flex items-center justify-center">{children}</div>
  );
}

/** The gate is still deciding: the config, Clerk or the account is loading. */
export function GateSpinner() {
  return (
    <GateScreen>
      <span role="status" aria-label="Chargement…">
        <AretePresence size={40} />
      </span>
    </GateScreen>
  );
}
