import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Scale } from 'lucide-react';
import { Button } from '@/components/ui';
import { formatKg } from '@/lib/bodyLog';
import { PainForm } from './PainForm';
import { WeightForm } from './WeightForm';

type Open = 'pain' | 'weight' | null;

/**
 * Quick entry of a pain or the day's weight, without a read: the dashboard
 * and a session page open it. `painDate` dates a pain on the session's day
 * (today when the log no longer accepts that day).
 */
export function BodyLogEntry({
  painDate,
  weight = true,
  trendLink = true,
}: {
  painDate?: string;
  weight?: boolean;
  /** The Santé page itself has no link to itself. */
  trendLink?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState<Open>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const toggle = (which: Exclude<Open, null>) => {
    setSaved(null);
    setOpen((current) => (current === which ? null : which));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="lg"
          aria-expanded={open === 'pain'}
          aria-controls={`${id}-form`}
          onClick={() => toggle('pain')}
        >
          <Activity aria-hidden className="size-4" />
          Signaler une douleur
        </Button>
        {weight && (
          <Button
            variant="outline"
            size="lg"
            aria-expanded={open === 'weight'}
            aria-controls={`${id}-form`}
            onClick={() => toggle('weight')}
          >
            <Scale aria-hidden className="size-4" />
            Noter mon poids
          </Button>
        )}
      </div>
      <div id={`${id}-form`}>
        {open === 'pain' && (
          <PainForm
            defaultDate={painDate}
            onCancel={() => setOpen(null)}
            onSaved={(entry) => {
              setOpen(null);
              setSaved(`Douleur enregistrée : ${entry.label}, ${entry.intensity}/10.`);
            }}
          />
        )}
        {open === 'weight' && (
          <WeightForm
            onCancel={() => setOpen(null)}
            onSaved={(entry) => {
              setOpen(null);
              setSaved(`Poids enregistré : ${formatKg(entry.weight_kg)}.`);
            }}
          />
        )}
      </div>
      {/* Always rendered: a live region that appears with its text may go unannounced. */}
      <p role="status" className="min-h-4 text-xs font-sans text-text-secondary">{saved}</p>
      {trendLink && (
        <Link to="/sante" className="inline-flex min-h-11 items-center text-xs font-sans text-neon-cyan hover:underline">
          Suivi des douleurs et du poids <span aria-hidden>&nbsp;→</span>
        </Link>
      )}
    </div>
  );
}
