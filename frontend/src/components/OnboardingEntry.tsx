import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useAuthState } from './auth/authState';
import { onboardingApi, onboardingKey, readDraft } from '@/lib/onboarding';

/** Also serves existing athletes without taking over their dashboard. */
export function OnboardingEntry() {
  const auth = useAuthState();
  const query = useQuery({ queryKey: onboardingKey, queryFn: onboardingApi.get, retry: false });
  const [deferred] = useState(() => {
    try { return readDraft(auth.athleteId!).deferred; }
    catch { return true; } // The form shows the storage error; never replace its source here.
  });
  if (query.data?.status === 'completed') return null;
  // Authenticated first visits start here; postponing is a browser-local choice.
  if (auth.enabled && query.data?.status === 'not_started' && !deferred) return <Navigate to="/onboarding" replace />;
  return <div className="mx-auto max-w-7xl px-6 pt-3"><Link className="inline-flex min-h-11 items-center gap-3 text-sm text-neon-cyan" to="/onboarding">Terminer ma configuration <ArrowRight size={16} aria-hidden="true" /></Link></div>;
}
