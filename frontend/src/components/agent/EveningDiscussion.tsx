import { useQuery } from '@tanstack/react-query';
import { coachApi, eveningKey } from '@/lib/coachToday';
import { parseLocalDate } from '@/lib/dates';
import { frenchClock } from '@/lib/fr';
import { readableError } from '@/lib/utils';
import { useCoachWords } from '@/lib/coachName';

/** The evening message is context, never a fabricated assistant turn: the
 *  first message of its thread answers the question, with no model request. */
export function EveningDiscussion({ id }: { id: number }) {
  const coach = useCoachWords();
  const query = useQuery({ queryKey: eveningKey(id), queryFn: () => coachApi.evening(id), retry: false });
  if (query.isPending) return <p role="status" className="text-sm text-text-muted">Chargement du message du soir…</p>;
  if (query.isError) return <div role="alert" className="text-sm text-danger-red">
    <p>Message du soir indisponible : {readableError(query.error)}</p>
    <button type="button" className="min-h-11 underline" onClick={() => void query.refetch()}>Réessayer</button>
  </div>;
  const message = query.data;
  const lead = message.text.endsWith(message.question) ? message.text.slice(0, -message.question.length).trim() : message.text;
  const day = parseLocalDate(message.for_date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  return <section aria-label="Message du soir dans cette conversation" className="mb-5 space-y-3">
    <div>
      <h3 className="text-sm font-medium text-text-primary">Pour demain, {day}</h3>
      <p className="mt-1 text-xs text-text-muted">Par {coach.the}{message.written_at ? ` · ${frenchClock(message.written_at)}` : ''}</p>
    </div>
    {lead && <p className="text-sm leading-relaxed text-text-secondary">{lead}</p>}
    <p className="text-sm font-medium leading-relaxed text-text-primary">{message.question}</p>
    <p role="status" className="border-t border-text-muted/15 pt-3 text-xs text-text-muted">
      {message.answer
        ? message.journaled
          ? `Ta réponse est notée dans le journal ${coach.of} : « ${message.answer} ». Écris-lui si tu veux en discuter.`
          : `Ta réponse est enregistrée (« ${message.answer} ») mais pas encore dans le journal ${coach.of} : nouvel essai à la prochaine ouverture.`
        : message.answerable
          ? `Réponds dans le champ ci-dessous : ta réponse est notée dans le journal ${coach.of} pour le briefing de demain, sans réponse immédiate.`
          : `Cette question est close : écris ${coach.to} si tu veux en parler.`}
    </p>
  </section>;
}
