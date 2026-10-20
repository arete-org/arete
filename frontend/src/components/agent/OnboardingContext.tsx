import { useQuery } from '@tanstack/react-query';
import { onboardingApi } from '@/lib/onboarding';
import { AgentMarkdown } from './AgentMarkdown';
import { useCoachName } from '@/lib/coachName';

/** Read the live ledger, never a browser copy that could resurrect forgotten data. */
export function OnboardingContext({ hideEmpty = false }: { hideEmpty?: boolean }) {
  const coach = useCoachName();
  const query = useQuery({ queryKey: ['onboarding-context'], queryFn: onboardingApi.context, retry: false, staleTime: 0 });
  if (query.isPending) return <p role="status">Chargement de ton profil…</p>;
  if (query.isError) return <p role="alert">Profil indisponible. <button className="min-h-11 underline" onClick={() => void query.refetch()}>Réessayer</button></p>;
  if (hideEmpty && !query.data.content) return null;
  return <section aria-label="Ton point de départ" className="mb-4 space-y-3 text-sm">
    <h3 className="font-semibold">Ton point de départ</h3>
    {query.data.content ? <AgentMarkdown text={query.data.content.replace(/<!-- onboarding:[^>]* -->/g, '')} /> : <p>Ce profil a été oublié. Aucune ancienne copie n’est transmise.</p>}
    <p className="text-xs text-text-muted">Ce contexte vient de tes réponses. Tu peux demander à {coach} de le corriger ou de l’oublier.</p>
  </section>;
}
