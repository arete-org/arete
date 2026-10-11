import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Check, ChevronLeft, ChevronRight, Plus, RefreshCw } from 'lucide-react';
import { AdherenceBar, CalendarWeek, ErrorState, LoadingState, strengthAsActual } from '@/components';
import { Button, Field, Input, Modal, ModalHeader, Panel, Textarea } from '@/components/ui';
import { garminApi, settingsApi, type PlannedSessionCreate } from '@/lib/api';
import { parseLocalDate, toLocalISODate } from '@/lib/dates';
import { qk, strengthSessionsQuery } from '@/lib/queryKeys';
import { weekStats } from '@/lib/sessionMatch';
import { cn } from '@/lib/utils';
import type { PlannedSession } from '@/types';
import { WeekPlanList } from './planning/WeekPlanList';
import { GarminExportPanel } from './planning/GarminExportPanel';
import { GoalProjectionPanel } from './planning/GoalProjectionPanel';
import { WeeklyReviewPanel } from './planning/WeeklyReviewPanel';

// Session types per sport category
const CARDIO_SESSION_TYPES = [
  { value: 'recovery', label: 'Récupération', color: 'text-success-green' },
  { value: 'endurance', label: 'Endurance', color: 'text-neon-cyan' },
  { value: 'tempo', label: 'Seuil', color: 'text-warning-orange' },
  { value: 'intervals', label: 'Fractionné', color: 'text-danger-red' },
  { value: 'long_run', label: 'Sortie longue', color: 'text-neon-purple' },
];

const STRENGTH_SESSION_TYPES = [
  { value: 'strength', label: 'Force', color: 'text-neon-gold' },
  { value: 'hypertrophy', label: 'Hypertrophie', color: 'text-neon-cyan' },
  { value: 'power', label: 'Puissance', color: 'text-danger-red' },
  { value: 'deload', label: 'Décharge', color: 'text-success-green' },
];

const OTHER_SESSION_TYPES = [
  { value: 'recovery', label: 'Récupération', color: 'text-success-green' },
  { value: 'endurance', label: 'Endurance', color: 'text-neon-cyan' },
  { value: 'other', label: 'Autre', color: 'text-text-muted' },
];

const SPORTS = [
  { value: 'running', label: 'Course', category: 'cardio' },
  { value: 'cycling', label: 'Vélo', category: 'cardio' },
  { value: 'swimming', label: 'Natation', category: 'cardio' },
  { value: 'strength', label: 'Muscu', category: 'strength' },
  { value: 'other', label: 'Autre', category: 'other' },
];

const INTENSITIES = [
  { value: 'easy', label: 'Facile', color: 'text-success-green' },
  { value: 'moderate', label: 'Modérée', color: 'text-warning-orange' },
  { value: 'hard', label: 'Dure', color: 'text-danger-red' },
] as const;

const HR_ZONES = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5'];

const getSessionTypesForSport = (sport: string) => {
  const sportConfig = SPORTS.find((s) => s.value === sport);
  switch (sportConfig?.category) {
    case 'cardio':
      return CARDIO_SESSION_TYPES;
    case 'strength':
      return STRENGTH_SESSION_TYPES;
    default:
      return OTHER_SESSION_TYPES;
  }
};

const getDefaultSessionType = (sport: string) => getSessionTypesForSport(sport)[0]?.value || 'endurance';

const emptyQuest = (date?: string): PlannedSessionCreate => ({
  date: date ?? toLocalISODate(),
  sport: 'running',
  session_type: getDefaultSessionType('running'),
  target_duration_min: 45,
  description: '',
  source: 'manual',
});

// Monday of the week `offset` weeks from now, ISO date
const getWeekStart = (offset: number) => {
  const today = new Date();
  const day = today.getDay();
  const diff = today.getDate() - day + (day === 0 ? -6 : 1) + offset * 7;
  return toLocalISODate(new Date(today.setDate(diff)));
};

const CHIP = 'px-3 py-1.5 rounded text-xs font-sans transition-all border';
const CHIP_IDLE = 'bg-abyss border-text-muted/30 text-text-muted hover:border-text-muted/50';

export function PlanningPage() {
  const queryClient = useQueryClient();
  const [weekOffset, setWeekOffset] = useState(() => {
    const day = new URLSearchParams(window.location.search).get('date');
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return 0;
    return Math.floor(Math.round((parseLocalDate(day).getTime() - parseLocalDate(getWeekStart(0)).getTime()) / 86_400_000) / 7);
  });
  // `?new=1` (the dashboard's "Ajouter une séance") opens the form once, then leaves the URL.
  const [searchParams, setSearchParams] = useSearchParams();
  const [showNewQuest, setShowNewQuest] = useState(() => searchParams.get('new') === '1');
  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('new');
        return next;
      },
      { replace: true }
    );
  }, [searchParams, setSearchParams]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const requestedDate = searchParams.get('date');
  const [lastRequestedDate, setLastRequestedDate] = useState(requestedDate);
  if (requestedDate !== lastRequestedDate) {
    setLastRequestedDate(requestedDate);
    if (requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
      setWeekOffset(Math.floor(Math.round((parseLocalDate(requestedDate).getTime() - parseLocalDate(getWeekStart(0)).getTime()) / 86_400_000) / 7));
      setSelectedDate(null);
    }
  }

  const [newQuest, setNewQuest] = useState<PlannedSessionCreate>(emptyQuest());
  const [toDelete, setToDelete] = useState<PlannedSession | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const today = toLocalISODate();
  const weekStart = getWeekStart(weekOffset);
  const weekEnd = useMemo(() => {
    const end = parseLocalDate(weekStart);
    end.setDate(end.getDate() + 6);
    return toLocalISODate(end);
  }, [weekStart]);
  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const d = parseLocalDate(weekStart);
        d.setDate(d.getDate() + i);
        return toLocalISODate(d);
      }),
    [weekStart]
  );

  const plannedQuery = useQuery({
    queryKey: qk.planned(weekStart, weekEnd),
    queryFn: () => garminApi.getPlanned(weekStart, weekEnd),
  });
  const actualQuery = useQuery({
    queryKey: qk.actual(weekStart, weekEnd),
    queryFn: () => garminApi.getActual(weekStart, weekEnd),
  });
  const strengthQuery = useQuery(strengthSessionsQuery);
  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: settingsApi.get });

  const afterChange = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: qk.planned() });
    queryClient.invalidateQueries({ queryKey: qk.actual() });
    setBusyId(null);
  }, [queryClient]);

  const createQuestMutation = useMutation({
    mutationFn: garminApi.createPlanned,
    onSuccess: () => {
      afterChange();
      setShowNewQuest(false);
      setNewQuest(emptyQuest(selectedDate ?? undefined));
    },
  });
  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: 'completed' | 'skipped' | 'pending' }) =>
      garminApi.setPlannedStatus(id, status),
    onSuccess: afterChange,
    onError: () => setBusyId(null),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => garminApi.deletePlanned(id),
    onSuccess: () => {
      afterChange();
      setToDelete(null);
    },
    onError: () => setBusyId(null),
  });

  const weekActual = useMemo(
    () => [
      ...(actualQuery.data ?? []),
      ...(strengthQuery.data ?? [])
        .filter((s) => s.date >= weekStart && s.date <= weekEnd)
        .map(strengthAsActual),
    ],
    [actualQuery.data, strengthQuery.data, weekStart, weekEnd]
  );

  const stats = useMemo(
    () => weekStats(days, plannedQuery.data ?? [], weekActual, today),
    [days, plannedQuery.data, weekActual, today]
  );

  const availableSessionTypes = useMemo(
    () => getSessionTypesForSport(newQuest.sport ?? 'running'),
    [newQuest.sport]
  );

  const handleSportChange = useCallback((sport: string) => {
    setNewQuest((prev) => ({ ...prev, sport, session_type: getDefaultSessionType(sport) }));
  }, []);

  if (plannedQuery.isLoading || actualQuery.isLoading) {
    return <LoadingState message="CHARGEMENT DU PLANNING…" />;
  }

  if (plannedQuery.isError || actualQuery.isError) {
    return (
      <ErrorState
        message="ÉCHEC DU CHARGEMENT DU PLANNING"
        onRetry={() => {
          plannedQuery.refetch();
          actualQuery.refetch();
        }}
      />
    );
  }

  return (
    <div className="page-shell bg-void">
      <div className="page-content">
        <header className="flex justify-between items-center mb-4 sm:mb-8 animate-fade-down">
          <h1 className="page-title">Planning</h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={afterChange}
              className="p-2 rounded transition-all duration-200 text-text-muted hover:text-neon-cyan hover:bg-abyss"
              aria-label="Rafraîchir"
            >
              <RefreshCw className="w-5 h-5" />
            </button>
            <Button
              onClick={() => {
                setNewQuest(emptyQuest(selectedDate ?? undefined));
                setShowNewQuest(true);
              }}
              className="px-3 py-1.5 sm:px-4 sm:py-2"
            >
              <Plus className="w-4 h-4" />
              NOUVELLE SÉANCE
            </Button>
          </div>
        </header>

        {/* Week Navigation */}
        <div className="flex items-center justify-between mb-4 sm:mb-6 animate-fade-in">
          <button
            type="button"
            onClick={() => setWeekOffset((prev) => prev - 1)}
            className="p-2 text-text-muted hover:text-neon-cyan transition-colors"
            aria-label="Semaine précédente"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-3">
            <span className="font-sans text-xs sm:text-sm text-text-secondary">
              {parseLocalDate(weekStart).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}
              {' — '}
              {parseLocalDate(weekEnd).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}
            </span>
            {weekOffset !== 0 && (
              <button
                type="button"
                onClick={() => {
                  setWeekOffset(0);
                  setSelectedDate(null);
                }}
                className="text-xs font-sans text-neon-cyan hover:underline"
              >
                Aujourd&apos;hui
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setWeekOffset((prev) => prev + 1)}
            className="p-2 text-text-muted hover:text-neon-cyan transition-colors"
            aria-label="Semaine suivante"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        <Panel className="mb-4 sm:mb-8 overflow-x-auto">
          <CalendarWeek
            startDate={weekStart}
            plannedSessions={plannedQuery.data || []}
            actualSessions={weekActual}
            onDayClick={(d) => setSelectedDate((prev) => (prev === d ? null : d))}
          />
        </Panel>

        <GarminExportPanel sessions={plannedQuery.data ?? []}>{workoutControls => <Panel title="SÉANCES DE LA SEMAINE" className="mb-4 sm:mb-8" delay={0.05}>
          <WeekPlanList
            workoutControls={workoutControls}
            days={days}
            planned={plannedQuery.data || []}
            actual={weekActual}
            selectedDate={selectedDate}
            today={today}
            restDays={settings?.rest_day_preference ?? []}
            busyId={busyId}
            onSelect={setSelectedDate}
            onStatus={(id, status) => {
              setBusyId(id);
              statusMutation.mutate({ id, status });
            }}
            onDelete={setToDelete}
          />
        </Panel>}</GarminExportPanel>

        <Panel title="ADHÉRENCE DE LA SEMAINE" className="mb-4 sm:mb-8" delay={0.1}>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 sm:gap-6">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-text-muted font-sans">Taux d&apos;adhérence</span>
                <span className="text-base sm:text-lg font-sans text-text-primary">{stats.rate}%</span>
              </div>
              <AdherenceBar score={stats.rate} size="lg" showLabel={false} />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-text-muted font-sans">Faites / dues à ce jour</span>
                <span className="text-sm font-sans text-text-secondary">
                  {stats.done} / {stats.due}
                </span>
              </div>
              <div className="flex gap-1 flex-wrap">
                {Array.from({ length: stats.due }).map((_, i) => (
                  <div
                    key={i}
                    className={cn('w-4 h-4 rounded-sm', i < stats.done ? 'bg-success-green' : 'bg-text-muted/20')}
                  />
                ))}
              </div>
            </div>

            <div className="flex items-center gap-6 text-xs font-sans">
              <div>
                <div className="text-xl sm:text-2xl font-sans font-bold text-danger-red">{stats.missed}</div>
                <div className="text-text-muted">manquées</div>
              </div>
              <div>
                <div className="text-xl sm:text-2xl font-sans font-bold text-warning-orange">{stats.offPlan}</div>
                <div className="text-text-muted">hors plan</div>
              </div>
            </div>
          </div>
        </Panel>

        <WeeklyReviewPanel />
        <GoalProjectionPanel />
      </div>

      <Modal open={showNewQuest} onClose={() => setShowNewQuest(false)} className="max-w-md p-4 sm:p-6">
        <ModalHeader
          title="NOUVELLE SÉANCE"
          icon={<Plus className="w-5 h-5" />}
          onClose={() => setShowNewQuest(false)}
          className="mb-4 sm:mb-6"
        />

        <form
          onSubmit={(e) => {
            e.preventDefault();
            createQuestMutation.mutate(newQuest);
          }}
          className="space-y-4"
        >
          <Field label="Date">
            <Input
              type="date"
              value={newQuest.date}
              onChange={(e) => setNewQuest((prev) => ({ ...prev, date: e.target.value }))}
              required
            />
          </Field>

          <Field label="Sport">
            <div className="flex flex-wrap gap-2">
              {SPORTS.map((sport) => (
                <button
                  key={sport.value}
                  type="button"
                  onClick={() => handleSportChange(sport.value)}
                  className={cn(
                    CHIP,
                    newQuest.sport === sport.value ? 'bg-neon-cyan/20 border-neon-cyan/50 text-neon-cyan' : CHIP_IDLE
                  )}
                >
                  {sport.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Type">
            <div className="flex flex-wrap gap-2">
              {availableSessionTypes.map((type) => (
                <button
                  key={type.value}
                  type="button"
                  onClick={() => setNewQuest((prev) => ({ ...prev, session_type: type.value }))}
                  className={cn(
                    CHIP,
                    newQuest.session_type === type.value ? `bg-abyss border-current ${type.color}` : CHIP_IDLE
                  )}
                >
                  {type.label}
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Durée (min)">
              <Input
                type="number"
                value={newQuest.target_duration_min || ''}
                onChange={(e) =>
                  setNewQuest((prev) => ({ ...prev, target_duration_min: parseInt(e.target.value) || undefined }))
                }
                placeholder="45"
                min={1}
                max={480}
              />
            </Field>
            <Field label="Distance (km)">
              <Input
                type="number"
                step="0.1"
                value={newQuest.target_distance_km || ''}
                onChange={(e) =>
                  setNewQuest((prev) => ({ ...prev, target_distance_km: parseFloat(e.target.value) || undefined }))
                }
                placeholder="10"
                min={0}
                max={500}
              />
            </Field>
          </div>

          <Field label="Intensité">
            <div className="flex flex-wrap gap-2">
              {INTENSITIES.map((it) => (
                <button
                  key={it.value}
                  type="button"
                  onClick={() =>
                    setNewQuest((prev) => ({
                      ...prev,
                      target_intensity: prev.target_intensity === it.value ? undefined : it.value,
                    }))
                  }
                  className={cn(
                    CHIP,
                    newQuest.target_intensity === it.value ? `bg-abyss border-current ${it.color}` : CHIP_IDLE
                  )}
                >
                  {it.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Zone FC">
            <div className="flex flex-wrap gap-2">
              {HR_ZONES.map((zone) => (
                <button
                  key={zone}
                  type="button"
                  onClick={() =>
                    setNewQuest((prev) => ({
                      ...prev,
                      target_hr_zone: prev.target_hr_zone === zone ? undefined : zone,
                    }))
                  }
                  className={cn(
                    CHIP,
                    newQuest.target_hr_zone === zone ? 'bg-neon-cyan/20 border-neon-cyan/50 text-neon-cyan' : CHIP_IDLE
                  )}
                >
                  {zone}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Description">
            <Textarea
              value={newQuest.description || ''}
              onChange={(e) => setNewQuest((prev) => ({ ...prev, description: e.target.value }))}
              placeholder="Footing Z2, relâchement…"
              rows={2}
            />
          </Field>

          {createQuestMutation.isError && (
            <p className="text-xs font-sans text-danger-red">
              Création impossible : {createQuestMutation.error?.message}
            </p>
          )}

          <Button type="submit" strong size="lg" fullWidth loading={createQuestMutation.isPending}>
            {createQuestMutation.isPending ? (
              'CRÉATION…'
            ) : (
              <>
                <Check className="w-4 h-4" />
                CRÉER LA SÉANCE
              </>
            )}
          </Button>
        </form>
      </Modal>

      <Modal open={toDelete !== null} onClose={() => setToDelete(null)} className="max-w-sm p-4 sm:p-6">
        <ModalHeader title="SUPPRIMER LA SÉANCE" onClose={() => setToDelete(null)} className="mb-4" />
        <p className="text-sm font-sans text-text-secondary mb-6">
          Supprimer la séance prévue le{' '}
          {toDelete && parseLocalDate(toDelete.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })} ?
        </p>
        <div className="flex gap-3 justify-end">
          <Button variant="ghost" onClick={() => setToDelete(null)}>
            Annuler
          </Button>
          <Button
            variant="danger"
            loading={deleteMutation.isPending}
            onClick={() => {
              if (toDelete) {
                setBusyId(toDelete.id);
                deleteMutation.mutate(toDelete.id);
              }
            }}
          >
            Supprimer
          </Button>
        </div>
      </Modal>
    </div>
  );
}
