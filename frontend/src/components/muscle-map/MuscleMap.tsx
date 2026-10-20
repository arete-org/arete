import { useState } from 'react';
import type { MuscleStat } from '@/types';
import { cn } from '@/lib/utils';
import { BODY, MIRROR, SHAPES, VIEW_LABEL, type View } from './paths';

/** Heat levels 0-4: cold, then warmer up to the hardest-worked region. */
const HEAT_FILL = ['fill-heat-0', 'fill-heat-1', 'fill-heat-2', 'fill-heat-3', 'fill-heat-4'] as const;
const HEAT_BG = ['bg-heat-0', 'bg-heat-1', 'bg-heat-2', 'bg-heat-3', 'bg-heat-4'] as const;

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = new Date(`${iso}T00:00:00`).getTime();
  if (Number.isNaN(then)) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - then) / 86_400_000);
}

function freshnessLabel(iso: string | null): string {
  const days = daysSince(iso);
  if (days === null) return 'jamais travaillé sur la période';
  if (days <= 0) return "travaillé aujourd'hui";
  if (days === 1) return 'travaillé hier';
  return `travaillé il y a ${days} jours`;
}

function volumeLabel(kg: number): string {
  if (kg <= 0) return '0 kg';
  return kg >= 1000 ? `${(kg / 1000).toFixed(1)} t` : `${Math.round(kg)} kg`;
}

/** The torso is drawn whole; arms and legs are drawn once and mirrored. */
function bodyPaths(view: View) {
  return (
    <>
      {BODY[view].full.map((d) => (
        <path key={d} d={d} />
      ))}
      {BODY[view].half.map((d) => (
        <g key={d}>
          <path d={d} />
          <path d={d} transform={MIRROR} />
        </g>
      ))}
    </>
  );
}

export interface MuscleMapProps {
  muscles: MuscleStat[];
  className?: string;
  onSelect?: (muscle: string) => void;
  selected?: string | null;
}

/**
 * Front and back silhouettes, each region shaded by how much work it took
 * relative to the busiest region of the window.
 */
export function MuscleMap({ muscles, className, onSelect, selected }: MuscleMapProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [touched, setTouched] = useState<string | null>(null);
  const byId = new Map(muscles.map((m) => [m.muscle, m]));
  const active = hovered ?? selected ?? touched;
  const detail = active ? byId.get(active) : undefined;

  const shapeClass = (muscle: string) =>
    cn(
      HEAT_FILL[byId.get(muscle)?.level ?? 0],
      'transition-all duration-200 cursor-pointer stroke-outline-dim stroke-[0.4]',
      active === muscle && 'brightness-125 stroke-neon-cyan stroke-[1.2]'
    );

  const renderView = (view: View) => (
    <figure className="flex min-w-0 max-w-[150px] flex-1 flex-col items-center gap-2 m-0">
      <figcaption className="text-[10px] font-sans text-text-muted">
        {VIEW_LABEL[view]}
      </figcaption>
      <svg viewBox="0 0 200 400" className="w-full h-auto aspect-[1/2]" role="img" aria-label={`Silhouette ${VIEW_LABEL[view]}`}>
        <g className="fill-shadow stroke-outline-dim stroke-[0.8]">
          <ellipse cx="100" cy="30" rx="18" ry="22" />
          <rect x="92" y="48" width="16" height="20" rx="5" />
          {bodyPaths(view)}
        </g>

        {SHAPES.filter((s) => s.view === view).map((shape) => {
          const stat = byId.get(shape.muscle);
          const title = `${stat?.label ?? shape.muscle} — ${volumeLabel(stat?.volume ?? 0)}`;
          const handlers = {
            className: shapeClass(shape.muscle),
            onMouseEnter: () => setHovered(shape.muscle),
            onMouseLeave: () => setHovered(null),
            onClick: () => { setTouched(shape.muscle); onSelect?.(shape.muscle); },
          };
          return (
            <g key={`${shape.view}-${shape.muscle}-${shape.d}`}>
              <title>{title}</title>
              <path d={shape.d} {...handlers} />
              <path d={shape.d} transform={MIRROR} {...handlers} />
            </g>
          );
        })}

        <g className="fill-none stroke-outline stroke-[1.1] pointer-events-none">{bodyPaths(view)}</g>
      </svg>
    </figure>
  );

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex justify-center items-start gap-6">
        {renderView('front')}
        {renderView('back')}
      </div>

      <label className="text-xs text-text-muted">
        Zone musculaire
        <select
          className="ui-input mt-2 min-h-11 w-full"
          value={selected ?? touched ?? ''}
          onChange={event => { const muscle = event.target.value; setTouched(muscle || null); if (muscle) onSelect?.(muscle); }}
        >
          <option value="">Choisir une zone</option>
          {muscles.map(muscle => <option key={muscle.muscle} value={muscle.muscle}>{muscle.label}</option>)}
        </select>
      </label>
      <div className="min-h-[3.25rem] text-center" aria-live="polite">
        {detail ? (
          <div className="animate-fade-up">
            <p className="text-sm font-sans text-text-primary">{detail.label}</p>
            <p className="text-xs font-sans text-text-secondary">
              {volumeLabel(detail.volume)}
              {detail.sets > 0 && ` · ${detail.sets} série${detail.sets > 1 ? 's' : ''}`}
            </p>
            <p className="text-xs text-text-muted">{freshnessLabel(detail.last_trained)}</p>
          </div>
        ) : (
          <p className="text-xs text-text-muted">Touche ou survole une zone pour le détail.</p>
        )}
      </div>

      <div className="flex justify-center items-center gap-3 text-[10px] font-sans">
        <span className="text-text-muted">Moins</span>
        {HEAT_BG.map((bg, level) => (
          <span key={bg} className={cn('w-5 h-3 rounded-sm', bg)} aria-label={`Niveau ${level}`} />
        ))}
        <span className="text-text-muted">Plus</span>
      </div>
    </div>
  );
}
