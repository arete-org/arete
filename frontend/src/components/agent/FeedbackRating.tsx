import { ThumbsDown, ThumbsUp } from 'lucide-react';

/** Shared feedback affordance; each surface owns its receipt and persistence. */
export function FeedbackRating({ value, disabled, onChange, labels = ['Réponse utile', 'Réponse peu utile'] }: {
  value: 0 | 1 | null;
  disabled?: boolean;
  onChange: (value: 0 | 1 | null) => void;
  labels?: readonly [string, string];
}) {
  return <>{([1, 0] as const).map(score => {
    const Icon = score ? ThumbsUp : ThumbsDown;
    const label = labels[score ? 0 : 1];
    return <button key={score} type="button" disabled={disabled} aria-pressed={value === score}
      aria-label={label} title={label} className="coach-feedback-action"
      onClick={() => onChange(value === score ? null : score)}><Icon aria-hidden="true" className="size-4" /></button>;
  })}</>;
}
