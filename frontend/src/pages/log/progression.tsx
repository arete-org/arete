import { Trophy, TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { recordTitle, recordValue, suggestionPrescription } from '@/lib/strengthProgress';
import type { SessionRecord, StrengthSuggestion } from '@/types';

/** The load the history suggests; a deload is shown as such, with its reason. */
export function SuggestionNote({ suggestion, label = 'Proposé' }: { suggestion: StrengthSuggestion; label?: string }) {
  const Icon = suggestion.deload ? TrendingDown : TrendingUp;
  return (
    <div
      className={cn(
        'mt-2 rounded border px-2 py-1.5 text-xs font-sans',
        suggestion.deload
          ? 'border-warning-orange/40 bg-warning-orange/5 text-warning-orange'
          : 'border-neon-cyan/30 bg-neon-cyan/5 text-neon-cyan'
      )}
    >
      <div className="flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden />
        <span>
          {suggestion.deload ? 'Allègement' : label} : {suggestionPrescription(suggestion)}
        </span>
      </div>
      <p className="mt-1 text-text-muted">{suggestion.reason}</p>
    </div>
  );
}

/** The records the saved session beat, grouped by exercise. */
export function RecordsCelebration({ records }: { records: SessionRecord[] }) {
  if (records.length === 0) return null;
  const byExercise = new Map<string, SessionRecord[]>();
  for (const record of records) {
    byExercise.set(record.exercise, [...(byExercise.get(record.exercise) ?? []), record]);
  }
  return (
    <section
      aria-label="Nouveaux records"
      className="text-left rounded border border-neon-gold/50 bg-neon-gold/10 p-3 animate-scale-in"
    >
      <h5 className="flex items-center gap-2 font-sans text-neon-gold">
        <Trophy className="w-5 h-5" aria-hidden />
        {records.length > 1 ? `${records.length} nouveaux records !` : 'Nouveau record !'}
      </h5>
      <ul className="mt-2 space-y-2">
        {[...byExercise].map(([exercise, items]) => (
          <li key={exercise} className="text-sm font-sans">
            <span className="text-text-primary">{exercise}</span>
            <ul className="text-xs text-text-secondary">
              {items.map((record) => (
                <li key={record.kind}>
                  {recordTitle(record)} : {recordValue(record)}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
