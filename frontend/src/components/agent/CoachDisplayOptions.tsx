import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Ellipsis, PanelsTopLeft } from 'lucide-react';
import type { CoachDisplay } from '@/hooks/useCoachDisplay';

type Props = {
  mode: CoachDisplay;
  onChange: (mode: CoachDisplay) => void;
  onHistory: () => void;
  onMemory: () => void;
  onCreate: () => void;
};

export function CoachDisplayOptions({ mode, onChange, onHistory, onMemory, onCreate }: Props) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const id = useId();
  const actions = [
    { action: onCreate, label: 'Nouvelle conversation' },
    { action: onHistory, label: 'Historique des conversations' },
    { action: onMemory, label: 'Ce que Chiron sait de moi' },
  ];
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const panel = container.current?.closest('#coach-panel');
    const viewport = window.visualViewport;
    const place = () => {
      if (!container.current || !popover.current) return;
      const bounds = container.current.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const above = bounds.top - top - 12;
      const below = top + (viewport?.height ?? window.innerHeight) - bounds.bottom - 12;
      const upwards = above > below;
      // Reposition as the streaming panel grows, keeping every option reachable.
      Object.assign(popover.current.style, {
        top: upwards ? 'auto' : 'calc(100% + 4px)',
        bottom: upwards ? 'calc(100% + 4px)' : 'auto',
        maxHeight: `${Math.max(0, Math.min(320, upwards ? above : below))}px`,
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (panel) observer.observe(panel);
    window.addEventListener('resize', place);
    viewport?.addEventListener('resize', place);
    viewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      viewport?.removeEventListener('resize', place);
      viewport?.removeEventListener('scroll', place);
    };
  }, [open]);
  const choose = (action: () => void) => {
    action();
    setOpen(false);
    trigger.current?.focus();
  };
  return <div ref={container} className="relative shrink-0" onKeyDown={event => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
  }}>
    <button ref={trigger} type="button" aria-label="Options du coach" aria-expanded={open} aria-controls={open ? id : undefined}
      className="flex size-9 items-center justify-center rounded-lg text-text-muted hover:bg-text-muted/10"
      onClick={() => setOpen(value => !value)}>
      {mode === 'floating' ? <Ellipsis size={17} /> : <PanelsTopLeft size={17} />}
    </button>
    {open && <div ref={popover} id={id} className="absolute right-0 z-50 w-64 max-w-[calc(100vw-48px)] overflow-y-auto rounded-xl border border-text-muted/20 bg-abyss p-2 text-sm shadow-xl">
      <fieldset>
        <legend className="px-2 py-2 text-[11px] text-text-muted">Affichage du coach</legend>
        {([['sidebar', 'Panneau latéral classique'], ['floating', 'Chat flottant']] as const).map(([value, label]) =>
          <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 hover:bg-text-muted/10">
            <input type="radio" name={id} value={value} checked={mode === value} onChange={() => choose(() => onChange(value))} className="accent-neon-cyan" />
            {label}
          </label>)}
      </fieldset>
      {mode === 'floating' && <div className="mt-1 border-t border-text-muted/15 pt-1">
        {actions.map(({ action, label }) =>
          <button key={label} type="button" onClick={() => choose(action)} className="block min-h-11 w-full rounded-lg px-2 text-left hover:bg-text-muted/10">{label}</button>)}
      </div>}
    </div>}
  </div>;
}
