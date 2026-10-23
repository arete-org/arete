import { useEffect, useId, useRef, useState } from 'react';
import { Check, MoreHorizontal, RefreshCw } from 'lucide-react';
import { Button, Select } from '@/components/ui';
import { SPORTS } from './sessionForm';

/** Week controls stay beside their trigger; opening never changes the plan. */
export function WeekOptions({
  sport,
  onSport,
  selecting,
  onSelect,
  onToday,
  onRefresh,
  busy,
}: {
  sport: string;
  onSport: (sport: string) => void;
  selecting: boolean;
  onSelect: () => void;
  onToday: () => void;
  onRefresh: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const host = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector('select')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !host.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  const choose = (action: () => void) => {
    action();
    close();
  };
  return (
    <div
      ref={host}
      className="planning-options"
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label="Options du planning"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        className="ui-button planning-options-trigger"
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal className="size-5" aria-hidden />
      </button>
      {open && (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label="Options du planning"
          className="planning-options-panel"
        >
          <h3 className="text-sm font-medium">Options de la semaine</h3>
          <label className="flex flex-col gap-2 text-xs text-text-muted">
            Sport
            <Select
              aria-label="Filtrer par sport"
              value={sport}
              onChange={(event) => onSport(event.target.value)}
            >
              <option value="">Tous les sports</option>
              {Object.entries(SPORTS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </label>
          <Button variant="ghost" onClick={() => choose(onToday)}>
            Aujourd’hui
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            aria-pressed={selecting}
            onClick={() => choose(onSelect)}
          >
            {selecting && <Check className="size-4" aria-hidden />}
            {selecting ? 'Terminer la sélection' : 'Sélectionner'}
          </Button>
          <Button variant="ghost" onClick={() => choose(onRefresh)}>
            <RefreshCw className="size-4" aria-hidden />
            Rafraîchir
          </Button>
        </div>
      )}
    </div>
  );
}
