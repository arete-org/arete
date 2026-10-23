import type { ReactNode } from 'react';
import { Component, type ErrorInfo } from 'react';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import type { Card, Headline, Tone } from '@/types';
import type { GlossaryId } from '@/lib/glossary';
import { cn } from '@/lib/utils';
import { GlossaryLink } from '@/components/GlossaryLink';

const TONE_CLASS: Record<Tone, string> = {
  good: 'text-success-green',
  neutral: 'text-text-secondary',
  warn: 'text-warning-orange',
  bad: 'text-danger-red',
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
        'inline-flex shrink-0 items-center gap-1 text-xs font-sans tabular-nums',
        TONE_CLASS[tone]
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
          <span className="text-danger-red font-sans text-sm">Graphique en erreur</span>
          <span className="text-text-muted text-xs font-sans">Les valeurs de synthèse restent disponibles.</span>
          <button className="ui-button min-h-11 px-3 text-neon-cyan" onClick={() => this.setState({ error: null })}>Réessayer le graphique</button>
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
  /** The glossary entry the title's "?" opens. */
  term?: GlossaryId;
  /** The glossary entry of each secondary label, by position. */
  secondaryTerms?: (GlossaryId | undefined)[];
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
  term,
  secondaryTerms = [],
  previousLabel,
  loading,
  error,
  children,
  className,
}: StatCardProps) {
  return (
    <section
      className={cn(
        'analysis-card',
        className
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <h3 className="text-[15px] font-medium text-text-primary">{title}</h3>
          {term && <GlossaryLink term={term} />}
        </div>
        {card && <DeltaBadge headline={card.headline} previousLabel={previousLabel} />}
      </header>
      <p className="text-xs text-text-muted">{question}</p>

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
          <div className="flex flex-col gap-3">
            <span className="text-[32px] font-semibold text-text-primary tabular-nums break-words">
              {card.headline.display}
            </span>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
            {card.secondary.map((h, i) => (
              <span key={secondaryLabels[i] ?? i} className="inline-flex items-center gap-1">
                {secondaryLabels[i]}
                {secondaryTerms[i] && <GlossaryLink term={secondaryTerms[i]} />}
                {secondaryLabels[i] && ' · '}
                <span className="tabular-nums">{h.display}</span>
              </span>
            ))}
            </div>
          </div>

          <p className={cn('analysis-insight', TONE_CLASS[card.insight.tone])}>
            {card.insight.text}
          </p>

          {children && <CardErrorBoundary>{children}</CardErrorBoundary>}
        </>
      )}
    </section>
  );
}
