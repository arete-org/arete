import { cn } from '@/lib/utils';
import { SESSION_TYPE_LABEL } from '@/components/SessionCard';
import { linkDay } from '@/lib/sessionMatch';
import { getSportColor, getSportIconComponent } from '@/lib/sport';
import type { ActualSession, PlannedSession } from '@/types';
import { parseLocalDate, toLocalISODate } from '@/lib/dates';

interface CalendarDayProps {
  date: string;
  planned: PlannedSession[];
  actual: ActualSession[];
  isToday: boolean;
  today: string;
  onClick?: () => void;
}

function CalendarDay({ date, planned, actual, isToday, today, onClick }: CalendarDayProps) {
  const dayOfWeek = parseLocalDate(date).toLocaleDateString('fr-FR', { weekday: 'short' }).toUpperCase().slice(0, 3);
  const dayNum = parseLocalDate(date).getDate();

  const link = linkDay(date, planned, actual, today);
  const allSessions = [
    ...link.planned.map((row) => ({
      key: `p${row.session.id}`,
      sport: row.session.sport,
      label: SESSION_TYPE_LABEL[row.session.session_type] ?? row.session.sport,
      title: row.session.description ?? undefined,
      state: row.state,
    })),
    ...link.offPlan.map((a) => ({
      key: `a${a.id}`,
      sport: a.sport,
      label: a.name || a.sport,
      title: a.name ?? undefined,
      state: 'offPlan' as const,
    })),
  ];

  const hasCompleted = link.planned.some((r) => r.state === 'done') || link.offPlan.length > 0;
  const hasPending = link.planned.some((r) => r.state === 'pending' || r.state === 'missed');
  const isRest = allSessions.length === 0;

  return (
    <div
      onClick={onClick}
      className={cn(
        'flex flex-col p-2 rounded transition-all duration-200',
        'border min-h-[120px]',
        onClick ? 'cursor-pointer hover:scale-[1.02]' : 'cursor-default',
        isToday && 'border-neon-cyan shadow-[0_0_15px_color-mix(in_srgb,var(--color-neon-cyan)_30%,transparent)]',
        hasCompleted && !isToday && 'border-success-green/40 bg-success-green/5',
        hasPending && !hasCompleted && !isToday && 'border-text-muted/30 bg-abyss/50',
        isRest && 'border-text-muted/10 bg-void/50'
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-sans text-text-muted tracking-wider">{dayOfWeek}.</span>
        <span className={cn('text-sm font-sans font-medium', isToday ? 'text-neon-cyan' : 'text-text-secondary')}>
          {dayNum}
        </span>
      </div>

      {allSessions.length > 0 ? (
        <div className="flex-1 flex flex-col gap-1">
          {allSessions.slice(0, 3).map((session) => {
            const IconComponent = getSportIconComponent(session.sport);
            const tone =
              session.state === 'done'
                ? 'bg-success-green/15 text-success-green'
                : session.state === 'missed'
                  ? 'bg-danger-red/10 text-danger-red'
                  : session.state === 'offPlan'
                    ? 'bg-warning-orange/10 text-warning-orange'
                    : 'bg-abyss/80 text-text-secondary';
            return (
              <div
                key={session.key}
                className={cn('flex items-center gap-1.5 px-1.5 py-1 rounded text-[11px] font-sans', tone)}
                title={session.title}
              >
                <IconComponent
                  size="sm"
                  className={cn(session.state === 'done' ? 'text-success-green' : getSportColor(session.sport))}
                />
                <span className="truncate capitalize">{session.label}</span>
                {session.state === 'done' && <span className="ml-auto">✓</span>}
              </div>
            );
          })}
          {allSessions.length > 3 && (
            <div className="text-[11px] text-text-muted font-sans text-center">+{allSessions.length - 3} autres</div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <span className="text-[11px] font-sans text-text-muted tracking-wider">Repos</span>
        </div>
      )}
    </div>
  );
}

interface CalendarWeekProps {
  startDate: string;
  plannedSessions: PlannedSession[];
  actualSessions: ActualSession[];
  onDayClick?: (date: string) => void;
}

export function CalendarWeek({ startDate, plannedSessions, actualSessions, onDayClick }: CalendarWeekProps) {
  const today = toLocalISODate();

  const days = Array.from({ length: 7 }, (_, i) => {
    const date = parseLocalDate(startDate);
    date.setDate(date.getDate() + i);
    return toLocalISODate(date);
  });

  const plannedByDate = new Map<string, PlannedSession[]>();
  plannedSessions.forEach((s) => {
    const dateKey = s.date.split('T')[0];
    if (!plannedByDate.has(dateKey)) plannedByDate.set(dateKey, []);
    plannedByDate.get(dateKey)!.push(s);
  });

  const actualByDate = new Map<string, ActualSession[]>();
  actualSessions.forEach((s) => {
    const dateKey = s.date.split('T')[0];
    if (!actualByDate.has(dateKey)) actualByDate.set(dateKey, []);
    actualByDate.get(dateKey)!.push(s);
  });

  return (
    <div className="grid grid-cols-7 gap-2">
      {days.map((date) => (
        <CalendarDay
          key={date}
          date={date}
          planned={plannedByDate.get(date) || []}
          actual={actualByDate.get(date) || []}
          isToday={date === today}
          today={today}
          onClick={onDayClick ? () => onDayClick(date) : undefined}
        />
      ))}
    </div>
  );
}
