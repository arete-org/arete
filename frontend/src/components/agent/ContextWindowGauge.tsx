import { useId, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { ContextWindowUsage } from '@/lib/agentStream';
import { cn } from '@/lib/utils';

const VISIBLE_FRACTION = 0.85;
const tokenFormat = new Intl.NumberFormat('fr-FR');

export function ContextWindowGauge({ usage, compacting }: {
  usage?: ContextWindowUsage;
  compacting: boolean;
}) {
  const { search } = useLocation();
  const id = useId();
  const [open, setOpen] = useState(false);
  if (!usage) return null;
  const fraction = usage.used_tokens / usage.window_tokens;
  if (!compacting && fraction < VISIBLE_FRACTION && !new URLSearchParams(search).has('contextGaugeAlways')) return null;
  const percent = Math.min(100, Math.round(fraction * 100));
  const tone = fraction >= 1 ? 'text-danger-red' : fraction >= VISIBLE_FRACTION ? 'text-warning-orange' : 'text-success-green';
  const label = compacting ? 'Compaction…' : `Contexte · ${percent} %`;
  return <div className="relative mt-1 flex justify-end font-sans text-[11px]">
    <div
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
      onKeyDown={event => { if (event.key === 'Escape') { setOpen(false); event.stopPropagation(); } }}
    >
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onFocus={event => { if (event.currentTarget.matches(':focus-visible')) setOpen(true); }}
        onClick={() => setOpen(true)}
        className="flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-text-secondary hover:bg-text-muted/10 focus-visible:outline-2 focus-visible:outline-neon-cyan [@media(pointer:coarse)]:min-h-11"
      >
        <span className={cn('flex', tone, compacting && 'motion-safe:animate-pulse')}>
          <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" className="-rotate-90">
            <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
            <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" pathLength="100" strokeDasharray={`${Math.min(100, fraction * 100)} 100`} strokeLinecap="round" />
          </svg>
        </span>
        <span className="tabular-nums">{label}</span>
      </button>
      <span className="sr-only" role="status">{compacting ? 'Compaction du contexte en cours.' : ''}</span>
      {open && <div id={id} role="tooltip" className="pointer-events-none absolute bottom-full right-0 z-30 mb-1 w-60 max-w-full rounded-xl border border-text-muted/20 bg-abyss p-3 text-text-secondary shadow-lg">
        <p className="font-medium text-text-primary">Contexte de la dernière requête</p>
        <p className="mt-1 tabular-nums">{tokenFormat.format(usage.used_tokens)} / {tokenFormat.format(usage.window_tokens)} tokens</p>
        <p className="mt-1 leading-relaxed">Estimation avant compaction. Les échanges restent dans ce fil.</p>
      </div>}
    </div>
  </div>;
}
