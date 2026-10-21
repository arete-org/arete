import { ArrowDown } from 'lucide-react';
import type { Answer } from '@/types';
import { SECTIONS } from './Section';

/**
 * The four answers the page opens on, computed by the server: each sentence
 * names its period and its source, the verdict is in its words (the colour
 * only repeats it), and its link leads to the cards of that question.
 */
export function Answers({
  answers,
  loading,
  onJump,
}: {
  answers?: Answer[];
  loading: boolean;
  onJump: (id: string) => void;
}) {
  return (
    <section className="analysis-answers" aria-labelledby="answers-title">
      <h2 id="answers-title" className="sr-only">Les quatre réponses</h2>
      <ul className="analysis-answers-grid">
        {SECTIONS.map((def) => {
          const answer = answers?.find((a) => a.id === def.answer);
          return (
            <li key={def.id} className="analysis-answer" data-tone={answer?.tone ?? 'neutral'}>
              <h3 className="analysis-answer-question">{answer?.question ?? def.title}</h3>
              <p className="analysis-answer-text">
                {answer ? answer.text : loading ? 'Chargement…' : 'Réponse indisponible.'}
              </p>
              <button type="button" className="analysis-answer-link" onClick={() => onJump(def.id)}>
                <ArrowDown className="size-4" aria-hidden />
                Voir les cartes
                <span className="sr-only"> : {def.title}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
