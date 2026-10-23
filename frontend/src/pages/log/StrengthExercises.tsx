import { cn } from '@/lib/utils';
import type { SessionExercise } from '@/types';

/** A Muscu log's exercises with their sets, warm-ups apart. */
export function StrengthExercises({ exercises }: { exercises: SessionExercise[] }) {
  return (
    <div className="space-y-3">
      {exercises.map((ex, idx) => (
        <div key={idx} className="p-3 bg-abyss rounded border border-text-muted/20">
          <div className="flex items-center justify-between mb-2">
            <span className="font-sans text-text-primary">
              {ex.exercise?.name || `Exercice n°${ex.exercise_id}`}
            </span>
            <span className="text-xs font-sans text-text-muted">{ex.sets?.length || 0} séries</span>
          </div>
          {ex.sets && ex.sets.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {ex.sets.map((set, setIdx) => (
                <div
                  key={setIdx}
                  className={cn(
                    'px-2 py-1 rounded text-xs font-sans',
                    set.is_warmup ? 'bg-info-blue/20 text-info-blue' : 'bg-neon-gold/10 text-neon-gold'
                  )}
                >
                  {set.weight_kg && `${set.weight_kg}kg × `}
                  {set.reps !== null ? `${set.reps}` : 'échec'}
                  {set.rpe && ` @${set.rpe}`}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
