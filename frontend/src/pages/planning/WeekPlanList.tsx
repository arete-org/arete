import type { ReactNode } from 'react';
import { OffPlanRow, SessionCard } from '@/components/SessionCard';
import { parseLocalDate } from '@/lib/dates';
import { linkDay } from '@/lib/sessionMatch';
import { cn } from '@/lib/utils';
import type { ActualSession, PlannedSession } from '@/types';

function dayLabel(iso: string): string {
  return parseLocalDate(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'short' });
}

export function WeekPlanList({
  workoutControls,
  days,
  planned,
  actual,
  selectedDate,
  today,
  restDays,
  busyId,
  onSelect,
  onStatus,
  onDelete,
}: {
  workoutControls?: (id: number) => ReactNode;
  days: string[];
  planned: PlannedSession[];
  actual: ActualSession[];
  selectedDate: string | null;
  today: string;
  restDays: string[];
  busyId: number | null;
  onSelect: (date: string | null) => void;
  onStatus: (id: number, status: 'completed' | 'skipped' | 'pending') => void;
  onDelete: (session: PlannedSession) => void;
}) {
  const shown = selectedDate ? days.filter((d) => d === selectedDate) : days;

  return (
    <div className="space-y-4">
      {selectedDate && (
        <button
          type="button"
          onClick={() => onSelect(null)}
          className="text-xs font-sans text-neon-cyan hover:underline"
        >
          ← Toute la semaine
        </button>
      )}
      {shown.map((date) => {
        const link = linkDay(
          date,
          planned.filter((p) => p.date === date),
          actual,
          today
        );
        const isToday = date === today;
        const weekday = parseLocalDate(date).toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
        const isRestDay = restDays.includes(weekday);
        const empty = link.planned.length === 0 && link.offPlan.length === 0;

        return (
          <section key={date}>
            <h3
              className={cn(
                'text-xs font-sans uppercase tracking-wider mb-2 flex items-center gap-2',
                isToday ? 'text-neon-cyan' : 'text-text-muted'
              )}
            >
              {dayLabel(date)}
              {isToday && <span className="text-[11px] border border-neon-cyan/40 rounded px-1">aujourd&apos;hui</span>}
            </h3>
            {empty ? (
              <p className="text-xs font-sans text-text-muted/70 pl-1">
                {isRestDay ? 'Repos prévu' : 'Repos'}
              </p>
            ) : (
              <div className="space-y-2">
                {link.planned.map(({ session, realised, state }) => (
                  <SessionCard
                    key={session.id}
                    planned={session}
                    realised={realised}
                    state={state}
                    busy={busyId === session.id}
                    onStatus={(status) => onStatus(session.id, status)}
                    onDelete={state === 'done' ? undefined : () => onDelete(session)}
                  >{workoutControls?.(session.id)}</SessionCard>
                ))}
                {link.offPlan.map((a) => (
                  <OffPlanRow key={a.id} session={a} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
