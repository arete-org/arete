import { useState } from 'react';
import { useIsMutating, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus, RefreshCw, MoreHorizontal } from 'lucide-react';
import { ErrorState, withStrengthLogs } from '@/components';
import { Button, Select, Modal, ModalHeader, Skeleton } from '@/components/ui';
import { WorkoutSelection } from '@/components/WorkoutSelection';
import { garminApi, settingsApi } from '@/lib/api';
import { exportApi } from '@/lib/documents';
import { parseLocalDate, toLocalISODate } from '@/lib/dates';
import { invalidateAfterSession, qk, strengthSessionsQuery } from '@/lib/queryKeys';
import { linkDay, weekStats } from '@/lib/sessionMatch';
import type { PlannedSession } from '@/types';
import { GarminExportPanel } from './planning/GarminExportPanel';
import { GoalProjectionPanel } from './planning/GoalProjectionPanel';
import { WeeklyReviewPanel } from './planning/WeeklyReviewPanel';
import { SessionEditor, type EditorState } from './planning/SessionEditor';
import { SessionDetail, MoveSession } from './planning/SessionDetail';
import { GarminState, PlanningSessionCard, WeekBoard } from './planning/WeekBoard';
import { dayLabel, sessionTitle, sessionSummary, sportLabel, SPORTS, STATE_LABELS } from './planning/sessionForm';
import './planning/planning.css';

function monday(date: string) {
  const d = parseLocalDate(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toLocalISODate(d);
}
function validDate(value: string | null, fallback: string) {
  return value &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(parseLocalDate(value).getTime()) &&
    toLocalISODate(parseLocalDate(value)) === value
    ? value
    : fallback;
}

export function PlanningPage() {
  const today = toLocalISODate();
  const client = useQueryClient();
  const busy = useIsMutating({ mutationKey: ['workout-action'] }) > 0;
  const [params, setParams] = useSearchParams();
  const selectedDate = validDate(params.get('date'), today);
  const weekStart = monday(selectedDate);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = parseLocalDate(weekStart);
    d.setDate(d.getDate() + i);
    return toLocalISODate(d);
  });
  const weekEnd = days[6];
  const [editor, setEditor] = useState<EditorState | null>(() =>
    params.get('new') === '1' ? { mode: 'create', date: selectedDate } : null,
  );
  const [activeId, setActiveId] = useState<number | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [moving, setMoving] = useState<{
    session: PlannedSession;
    date?: string;
  } | null>(null);
  const [dragged, setDragged] = useState<PlannedSession | null>(null);
  const [sport, setSport] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [message, setMessage] = useState('');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [analysisOpened, setAnalysisOpened] = useState(false);
  const plannedQuery = useQuery({
    queryKey: qk.planned(weekStart, weekEnd),
    queryFn: () => garminApi.getPlanned(weekStart, weekEnd),
  });
  const actualQuery = useQuery({
    queryKey: qk.actual(weekStart, weekEnd),
    queryFn: () => garminApi.getActual(weekStart, weekEnd),
  });
  const strengthQuery = useQuery(strengthSessionsQuery);
  const settingsQuery = useQuery({
    queryKey: qk.settings,
    queryFn: settingsApi.get,
  });
  const exportsQuery = useQuery({
    queryKey: ['garmin-exports'],
    queryFn: exportApi.statuses,
    retry: false,
  });
  const planned = plannedQuery.data ?? [];
  const actual = withStrengthLogs(
    actualQuery.data ?? [],
    (strengthQuery.data ?? []).filter((s) => s.date >= weekStart && s.date <= weekEnd),
  );
  const rows = days.flatMap(
    (date) =>
      linkDay(
        date,
        planned.filter((s) => s.date === date),
        actual,
        today,
      ).planned,
  );
  const stats = weekStats(days, planned, actual, today);
  const next = rows.find((r) => r.session.date >= today && r.state === 'pending');
  const active =
    rows.find((r) => r.session.id === activeId) ??
    rows.find((r) => r.session.date === selectedDate) ??
    next ??
    rows[0];
  const detail = rows.find((r) => r.session.id === detailId);
  const restDays = settingsQuery.data?.rest_day_preference ?? [];
  const freeDays = days.filter((date) => !planned.some((s) => s.date === date)).length;
  const day = (date: string) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('date', date);
      next.delete('new');
      return next;
    });
  };
  const shift = (delta: number) => {
    const d = parseLocalDate(selectedDate);
    d.setDate(d.getDate() + delta * 7);
    day(toLocalISODate(d));
    setActiveId(null);
  };
  const closeEditor = () => {
    setEditor(null);
    if (params.has('new')) day(selectedDate);
  };
  const saved = (session: PlannedSession, text: string) => {
    closeEditor();
    setMoving(null);
    setDetailId(null);
    setActiveId(session.id);
    day(session.date);
    setMessage(text);
  };

  // The page frame and week controls show at once; the week fills in when it arrives.
  const loading = plannedQuery.isPending || actualQuery.isPending;
  if (plannedQuery.error || actualQuery.error)
    return (
      <ErrorState
        message="ÉCHEC DU CHARGEMENT DU PLANNING"
        onRetry={() => {
          void plannedQuery.refetch();
          void actualQuery.refetch();
        }}
      />
    );
  return (
    <div className="page-shell planning-shell bg-void">
      <div className="page-content planning-content">
        <header className="planning-header">
          <div>
            <h1 className="page-title planning-title">
              <span className="planning-desktop-title">Votre semaine, en un regard.</span>
              <span className="planning-mobile-title">Planning</span>
            </h1>
            <p className="text-sm text-text-secondary mt-2">Planning · {dayLabel(weekStart)}</p>
          </div>
          <Button
            className="planning-desktop-create"
            strong
            onClick={() => setEditor({ mode: 'create', date: selectedDate })}
          >
            <Plus className="size-4" />
            Nouvelle séance
          </Button>
        </header>
        <div className="planning-summary">
          {loading ? (
            [0, 1, 2].map((i) => (
              <section key={i} className="glass-panel p-5">
                <Skeleton label="Chargement du résumé de la semaine" />
              </section>
            ))
          ) : (
            <>
              <section className="glass-panel p-5">
                <p className="planning-eyebrow">Séances</p>
                <p className="mt-2 text-[26px] font-semibold tabular-nums">
                  {rows.filter((r) => r.state === 'done').length}
                  <span> / {planned.length}</span>
                </p>
                <p className="mt-2 text-xs text-text-secondary">
                  {stats.due
                    ? `${stats.rate} % des séances dues réalisées`
                    : 'La semaine est devant vous.'}
                </p>
              </section>
              <section className="glass-panel p-5">
                <p className="planning-eyebrow">Récupération</p>
                <p className="mt-2 text-[26px] font-semibold">
                  {freeDays}{' '}
                  <span className="text-[26px]">
                    jour{freeDays > 1 ? 's' : ''} libre{freeDays > 1 ? 's' : ''}
                  </span>
                </p>
                <p className="mt-2 text-xs text-text-secondary">Sans séance planifiée cette semaine.</p>
              </section>
              <section className="glass-panel p-5 planning-next">
                <p className="text-sm font-semibold">Prochaine séance</p>
                {next ? (
                  <button
                    className="planning-next-link block text-left mt-2"
                    onClick={() => setDetailId(next.session.id)}
                  >
                    <span className="text-sm text-text-secondary">
                      {dayLabel(next.session.date)} · {sessionTitle(next.session)} ·{' '}
                      {sessionSummary(next.session)}
                    </span>
                  </button>
                ) : (
                  <p className="text-sm text-text-secondary mt-3">
                    Aucune séance à venir cette semaine.
                  </p>
                )}
              </section>
            </>
          )}
        </div>
        {message && (
          <div role="status" className="ui-inset p-4 my-4 text-sm flex justify-between gap-3">
            <p>{message}</p>
            <button aria-label="Masquer le message" onClick={() => setMessage('')}>
              ×
            </button>
          </div>
        )}
        {strengthQuery.error && (
          <p role="alert" className="text-sm text-danger-red my-3">
            Activités de musculation indisponibles.{' '}
            <button className="underline" onClick={() => void strengthQuery.refetch()}>
              Réessayer
            </button>
          </p>
        )}
        {settingsQuery.error && (
          <p role="alert" className="text-sm text-danger-red my-3">
            Préférences de repos indisponibles.{' '}
            <button className="underline" onClick={() => void settingsQuery.refetch()}>
              Réessayer
            </button>
          </p>
        )}
        <section className="planning-calendar" aria-label="Planning hebdomadaire">
          <div className="planning-toolbar">
            <div className="planning-week-controls">
              <h2 className="font-semibold tabular-nums">
                {parseLocalDate(weekStart).toLocaleDateString('fr-FR', {
                  day: 'numeric',
                  month: weekStart.slice(0, 7) === weekEnd.slice(0, 7) ? undefined : 'short',
                })}{' '}
                –{' '}
                {parseLocalDate(weekEnd).toLocaleDateString('fr-FR', {
                  day: 'numeric',
                  month: 'long',
                })}
              </h2>
              <Button variant="ghost" aria-label="Semaine précédente" onClick={() => shift(-1)}>
                <ChevronLeft className="size-4" />
              </Button>
              <Button variant="ghost" aria-label="Semaine suivante" onClick={() => shift(1)}>
                <ChevronRight className="size-4" />
              </Button>
              <Button className="planning-today" variant="ghost" onClick={() => day(today)}>
                Aujourd’hui
              </Button>
            </div>
            <div className="planning-extra-controls">
              <Select
                className="planning-sport-filter"
                aria-label="Filtrer par sport"
                value={sport}
                onChange={(e) => setSport(e.target.value)}
              >
                <option value="">Tous les sports</option>
                {Object.entries(SPORTS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
              <Button
                variant="ghost"
                aria-label="Options du planning"
                onClick={() => setOptionsOpen(true)}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </div>
          </div>
          {exportsQuery.error && (
            <p role="alert" className="text-sm text-danger-red px-5 pb-4">
              État Garmin indisponible.{' '}
              <button className="underline" onClick={() => void exportsQuery.refetch()}>
                Réessayer
              </button>
            </p>
          )}
          {loading ? (
            <Skeleton label="Chargement de la semaine" lines={4} className="px-5 pb-5" />
          ) : (
            <WorkoutSelection
              key={`${weekStart}:${selecting}:${sport}`}
              locked={busy || !!exportsQuery.error || exportsQuery.isPending}
              sessions={planned.map((session) => ({
                session: { ...session, revision: session.revision ?? 1 },
                export: exportsQuery.data?.find((e) => e.session_id === session.id) ?? null,
              }))}
              renderWorkout={(workout) => {
                const row = rows.find((r) => r.session.id === workout.sessionId);
                return (
                  row && (
                    <PlanningSessionCard
                      planned={row.session}
                      state={row.state}
                      realised={row.realised}
                      workout={workout}
                      active={active?.session.id === row.session.id}
                      selecting={selecting}
                      exportUnavailable={!!exportsQuery.error || exportsQuery.isPending}
                      onActivate={() => {
                        setActiveId(row.session.id);
                        day(row.session.date);
                      }}
                      onOpen={() => setDetailId(row.session.id)}
                      onDrag={setDragged}
                    />
                  )
                );
              }}
            >
              {(render) => (
                <WeekBoard
                  days={days}
                  planned={planned}
                  actual={actual}
                  today={today}
                  selectedDate={selectedDate}
                  restDays={restDays}
                  sport={sport}
                  render={render}
                  summary={
                    <>
                      <span className="text-success-green">
                        {rows.filter((r) => r.state === 'done').length} / {planned.length} réalisée
                        {rows.filter((r) => r.state === 'done').length > 1 ? 's' : ''}
                      </span>
                      <span>{freeDays} jours libres</span>
                      {sport && <span>{sportLabel(sport)}</span>}
                    </>
                  }
                  onDay={(date) => {
                    setActiveId(null);
                    day(date);
                  }}
                  onCreate={(date) => setEditor({ mode: 'create', date })}
                  onDropSession={(date) => {
                    if (dragged && dragged.date !== date && !busy)
                      setMoving({ session: dragged, date });
                    setDragged(null);
                  }}
                />
              )}
            </WorkoutSelection>
          )}
        </section>
        {active && (
          <section className="planning-active glass-panel" aria-label="Séance sélectionnée">
            <div className="min-w-0">
              <p className="planning-eyebrow">
                {dayLabel(active.session.date)} · {STATE_LABELS[active.state]}
              </p>
              <h2 className="text-lg font-semibold my-2 break-words">
                {sessionTitle(active.session)}
              </h2>
              <GarminState
                state={{
                  session: {
                    ...active.session,
                    revision: active.session.revision ?? 1,
                  },
                  export:
                    exportsQuery.data?.find((e) => e.session_id === active.session.id) ?? null,
                }}
                unavailable={!!exportsQuery.error || exportsQuery.isPending}
              />
            </div>
            <div className="planning-active-summary">
              <p className="text-[13px]">{sessionSummary(active.session)}</p>
              <p className="text-xs text-text-muted mt-2">
                Consulter le détail pour les cibles et les étapes.
              </p>
            </div>
            <Button strong onClick={() => setDetailId(active.session.id)}>
              Ouvrir la séance
            </Button>
          </section>
        )}
        <GarminExportPanel />
        <Button
          className="planning-mobile-create"
          onClick={() => setEditor({ mode: 'create', date: selectedDate })}
        >
          <Plus className="size-4" /> Nouvelle séance
        </Button>
        <Modal
          open={optionsOpen}
          onClose={() => setOptionsOpen(false)}
          label="Options du planning"
          mobileSheet
          className="planning-dialog max-w-sm"
        >
          <ModalHeader title="Options du planning" onClose={() => setOptionsOpen(false)} />
          <div className="flex flex-col gap-3">
            <Select
              aria-label="Filtrer par sport"
              value={sport}
              onChange={(e) => setSport(e.target.value)}
            >
              <option value="">Tous les sports</option>
              {Object.entries(SPORTS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
            <Button
              onClick={() => {
                day(today);
                setOptionsOpen(false);
              }}
            >
              Aujourd’hui
            </Button>
            <Button
              disabled={busy}
              aria-pressed={selecting}
              onClick={() => {
                setSelecting(!selecting);
                setOptionsOpen(false);
              }}
            >
              {selecting ? 'Terminer la sélection' : 'Sélectionner'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                void invalidateAfterSession(client);
                setOptionsOpen(false);
              }}
            >
              <RefreshCw className="size-4" /> Rafraîchir
            </Button>
          </div>
        </Modal>
        {/* Collapsed by default: the review and the goal projection load when first opened. */}
        <details
          className="planning-analysis"
          onToggle={(e) => {
            if (e.currentTarget.open) setAnalysisOpened(true);
          }}
        >
          <summary className="min-h-11 text-sm font-semibold cursor-pointer">
            Bilan et objectifs
          </summary>
          {analysisOpened && (
            <div className="space-y-5 mt-4">
              <WeeklyReviewPanel />
              <GoalProjectionPanel />
            </div>
          )}
        </details>
        {detail && !editor && !moving && (
          <SessionDetail
            session={detail.session}
            state={detail.state}
            realised={detail.realised}
            onClose={() => setDetailId(null)}
            onEdit={() =>
              setEditor({
                mode: 'edit',
                session: detail.session,
                date: detail.session.date,
              })
            }
            onMove={() => setMoving({ session: detail.session })}
            onDuplicate={() =>
              setEditor({
                mode: 'duplicate',
                session: detail.session,
                date: detail.session.date,
              })
            }
            onChanged={(session, text) => saved(session, text)}
            onDeleted={(text) => {
              setDetailId(null);
              setActiveId(null);
              setMessage(text);
            }}
          />
        )}
        {editor && (
          <SessionEditor
            editor={editor}
            onClose={closeEditor}
            onSaved={(session) =>
              saved(
                session,
                editor.mode === 'edit'
                  ? 'Séance mise à jour.'
                  : editor.mode === 'duplicate'
                    ? 'Copie créée.'
                    : 'Séance créée.',
              )
            }
          />
        )}
        {moving && (
          <MoveSession
            session={moving.session}
            date={moving.date}
            restDays={restDays}
            onClose={() => setMoving(null)}
            onMoved={(session) => saved(session, 'Séance déplacée.')}
          />
        )}
      </div>
    </div>
  );
}
