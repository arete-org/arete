import type { ReactNode } from 'react';
import { Component, type ErrorInfo } from 'react';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import type { Card, Headline, Tone } from '@/types';
import { cn } from '@/lib/utils';

const TONE_CLASS: Record<Tone, string> = {
  good: 'text-success-green',
  neutral: 'text-text-secondary',
  warn: 'text-warning-orange',
  bad: 'text-danger-red',
};

const TONE_BORDER: Record<Tone, string> = {
  good: 'border-l-success-green',
  neutral: 'border-l-text-muted',
  warn: 'border-l-warning-orange',
  bad: 'border-l-danger-red',
};

/** Green when the change goes the way this metric wants, red when it does not. */
function deltaTone(headline: Headline): 'good' | 'bad' | 'neutral' {
  if (!headline.delta || headline.better === 'neutral') return 'neutral';
  const improving = headline.better === 'up' ? headline.delta > 0 : headline.delta < 0;
  return improving ? 'good' : 'bad';
}

function DeltaBadge({ headline, previousLabel }: { headline: Headline; previousLabel: string }) {
  if (headline.delta === null || headline.previous === null) return null;
  const tone = deltaTone(headline);
  const Icon = headline.delta > 0 ? TrendingUp : headline.delta < 0 ? TrendingDown : Minus;
  const pct = headline.delta_pct;
  const text = pct === null ? `${headline.delta > 0 ? '+' : ''}${headline.delta}` : `${pct > 0 ? '+' : ''}${Math.round(pct)} %`;

  return (
    <span
      title={`Par rapport ${previousLabel} : ${headline.previous}${headline.unit ? ` ${headline.unit}` : ''}`}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-sans',
        tone === 'good' && 'bg-success-green/10 text-success-green',
        tone === 'bad' && 'bg-danger-red/10 text-danger-red',
        tone === 'neutral' && 'bg-shadow text-text-secondary'
      )}
    >
      <Icon className="w-3 h-3" aria-hidden />
      {text}
    </span>
  );
}

class CardErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[StatCard]', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-[220px] flex flex-col items-center justify-center gap-2 text-center px-4">
          <span className="text-danger-red font-sans text-xs uppercase tracking-wider">Graphique en erreur</span>
          <span className="text-text-muted text-xs font-sans">{this.state.error.message}</span>
        </div>
      );
    }
    return this.props.children;
  }
}

export interface StatCardProps {
  /** Card title, e.g. "Volume". */
  title: string;
  /** What the headline number answers, one short line. */
  question: string;
  card?: Card;
  /** Labels for the secondary headlines, in the order the API sends them. */
  secondaryLabels?: string[];
  previousLabel: string;
  loading?: boolean;
  error?: boolean;
  children?: ReactNode;
  className?: string;
}

/**
 * One analytics card: a headline with its delta, up to three supporting
 * numbers, the sentence that reads them, then the chart.
 */
export function StatCard({
  title,
  question,
  card,
  secondaryLabels = [],
  previousLabel,
  loading,
  error,
  children,
  className,
}: StatCardProps) {
  return (
    <section
      className={cn(
        'bg-abyss rounded-lg border border-text-muted/20 p-4 flex flex-col gap-3',
        className
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-sans text-neon-cyan uppercase tracking-wider">{title}</h3>
          <p className="text-xs text-text-muted mt-0.5">{question}</p>
        </div>
        {card && <DeltaBadge headline={card.headline} previousLabel={previousLabel} />}
      </header>

      {loading ? (
        <div className="h-[260px] flex items-center justify-center text-text-muted font-sans text-sm animate-pulse">
          Chargement…
        </div>
      ) : error || !card ? (
        <div className="h-[260px] flex items-center justify-center text-danger-red font-sans text-sm">
          Données indisponibles
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <span className="text-3xl font-bold font-sans text-text-primary tabular-nums">
              {card.headline.display}
            </span>
            {card.secondary.map((h, i) => (
              <span key={secondaryLabels[i] ?? i} className="flex flex-col">
                <span className="text-[10px] uppercase tracking-wider text-text-muted font-sans">
                  {secondaryLabels[i] ?? ''}
                </span>
                <span className="text-base font-sans text-text-secondary tabular-nums">{h.display}</span>
              </span>
            ))}
          </div>

          <p className={cn('text-sm border-l-2 pl-3 py-1', TONE_CLASS[card.insight.tone], TONE_BORDER[card.insight.tone])}>
            {card.insight.text}
          </p>

          {children && <CardErrorBoundary>{children}</CardErrorBoundary>}
        </>
      )}
    </section>
  );
}
