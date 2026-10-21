import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { GlossaryLink } from '@/components/GlossaryLink';
import { RpePicker } from '@/components/RpePicker';
import { useCoachWords } from '@/lib/coachName';
import type { ActivityDetail } from '@/types';
import { summaryNumbers } from './summaryNumbers';
import { leadSentence, nextDayLine } from './summaryText';

/**
 * What a session's page opens with: its three numbers, the coach's word in
 * one sentence and what the plan holds next. All from the detail payload: no
 * request of its own, no model call.
 */
export function SessionSummary({ detail, focusRpe }: { detail: ActivityDetail; focusRpe: boolean }) {
  const coach = useCoachWords();
  const [open, setOpen] = useState(false);
  const numbers = summaryNumbers(detail);
  const { summary, session } = detail;
  const word = detail.feedback ?? (summary.rule_feedback ? { text: summary.rule_feedback, source: 'rules' as const } : null);
  const [lead, more] = word ? leadSentence(word.text) : ['', ''];
  const next = summary.next_day ? nextDayLine(summary.next_day, coach) : null;

  return (
    <section aria-labelledby="session-summary-title" className="glass-panel p-4 sm:p-6 space-y-4">
      <h2 id="session-summary-title" className="font-sans font-medium text-[15px] text-ink-primary">
        L’essentiel de la séance
      </h2>
      {numbers.length > 0 && (
        <dl className="grid grid-cols-3 gap-2 sm:gap-3">
          {numbers.map((number) => (
            <div key={number.label} className="ui-inset min-w-0 p-2.5 sm:p-3">
              <dt className="flex items-start gap-1 text-[11px] sm:text-xs text-ink-muted break-words">
                <span className="min-w-0">{number.label}</span>
                {number.term && <GlossaryLink term={number.term} about="résumé" />}
              </dt>
              <dd className="mt-1 text-base sm:text-2xl font-semibold text-ink-primary tabular-nums break-words">{number.value}</dd>
              {number.detail && <dd className="text-[11px] sm:text-xs text-ink-secondary break-words">{number.detail}</dd>}
            </div>
          ))}
        </dl>
      )}
      {word && (
        <div>
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-accent">
            <Sparkles className="size-3.5" aria-hidden />
            {word.source === 'agent' ? `Le mot ${coach.of}` : 'Calculé à partir de la séance'}
          </h3>
          <p className="mt-1 text-sm text-ink-primary">{lead}</p>
          {more && open && <p className="mt-1 text-sm text-ink-secondary whitespace-pre-line">{more}</p>}
          {more && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="min-h-11 text-sm text-accent underline underline-offset-2"
            >
              {open ? 'Réduire' : 'Lire la suite'}
            </button>
          )}
        </div>
      )}
      {next && (
        <div className="text-sm">
          <p>
            <span className="font-medium text-ink-primary">{next.label} :</span>{' '}
            <span className="text-ink-secondary">{next.text}</span>
          </p>
          {next.reasons.map((reason) => (
            <p key={reason} className="mt-0.5 text-xs text-ink-muted">{reason}</p>
          ))}
        </div>
      )}
      {session.rpe == null && <RpePicker sessionId={session.id} autoFocus={focusRpe} />}
    </section>
  );
}
