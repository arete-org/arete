import { CoachingAttention } from '@/components/agent/CoachingAttention';
import { BriefingCard } from '@/components/BriefingCard';
import { PlayerSummary } from '@/components/PlayerSummary';
import { useGamePreference } from '@/lib/gamification';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Dumbbell, HeartPulse, TrendingUp, Zap } from 'lucide-react';
import { MetricCard, SessionCard, withStrengthLogs } from '@/components';
import { CompletedSession } from '@/components/dashboard/CompletedSession';
import { DailyMarkers } from '@/components/dashboard/DailyMarkers';
import { CheckinCard } from '@/components/dashboard/CheckinCard';
import { BodyLogEntry } from '@/components/body/BodyLogEntry';
import { PushOffer } from '@/components/PushOffer';
import { MovedSession, RenegotiationOutcome } from '@/components/dashboard/RenegotiationOutcome';
import { RenegotiateMenu } from '@/components/dashboard/RenegotiateMenu';
import { SESSION_TYPE_LABEL } from '@/components/SessionCard';
import { WeekReviewEntry } from '@/components/dashboard/WeekReviewEntry';
import { Panel, Skeleton } from '@/components/ui';
import { planApi, settingsApi } from '@/lib/api';
import { fetchDashboard, type DashboardData } from '@/lib/dashboard';
import { exportApi } from '@/lib/documents';
import { readWorkouts, watchLine, workoutsKey, type WorkoutView } from '@/lib/workouts';
import { renegotiationOutcome, revertOutcome, type DayOutcome, type Renegotiation } from '@/lib/renegotiation';
import { readableError } from '@/lib/utils';
import { useDailyTip } from '@/lib/dailyTip';
import { formatDecimal, formatHoursMinutes, weeksAtGoalText } from '@/lib/fr';
import { cn } from '@/lib/utils';
import type { GlossaryId } from '@/lib/glossary';
import { GlossaryLink } from '@/components/GlossaryLink';
import { importChunk } from '@/lib/chunkReload';
import { toLocalISODate } from '@/lib/dates';
import { invalidateAfterSession, qk } from '@/lib/queryKeys';
import { linkDay, type DayLink } from '@/lib/sessionMatch';
import type { PlanDecision, StatBar } from '@/types';

/** Readiness / stress traffic lights as Tailwind classes (theme colors).
 *  `threshold` is the user's fatigue threshold from Settings (default 85). */
const readinessTone = (score: number, threshold: number) =>
  score >= threshold
    ? 'text-neon-cyan border-neon-cyan'
    : score >= threshold * 0.6
      ? 'text-neon-gold border-neon-gold'
      : 'text-danger-red border-danger-red';
const stressTone = (avg: number) => (avg > 40 ? 'text-danger-red' : avg > 25 ? 'text-neon-gold' : 'text-success-green');
// Each colour above also reads as words: a colour alone says nothing to a screen reader or a colour-blind eye.
const readinessWord = (score: number, threshold: number) =>
  score >= threshold ? 'bonne' : score >= threshold * 0.6 ? 'moyenne' : 'basse';
const stressWord = (avg: number) => (avg > 40 ? 'élevé' : avg > 25 ? 'modéré' : 'faible');
const HRV_WORD: Record<string, string> = { BALANCED: 'équilibrée', UNBALANCED: 'déséquilibrée', LOW: 'basse', POOR: 'faible' };



// The race goal and the form curve keep the entry chunk unchanged (ARE-46): their
// code, and recharts after it, load beside the dashboard's answer.
const loadOutlook = importChunk(() => import('@/components/dashboard/outlook'));
const GoalCard = lazy(() => loadOutlook().then((m) => ({ default: m.GoalCard })));
const FormCurvePanel = lazy(() => loadOutlook().then((m) => ({ default: m.FormCurvePanel })));

/** Shown on a repeat visit while cached data waits for its refresh (a cold server can take seconds). */
const STALE_HINT_MS = 10 * 60_000;
function UpdatedAgo({ at }: { at: number }) {
  const [now] = useState(Date.now);
  const age = now - at;
  if (!at || age < STALE_HINT_MS) return null;
  const ago = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
  return (
    <p className="text-[11px] font-sans text-text-muted mt-0.5">
      Mis à jour {age < 3_600_000 ? ago.format(-Math.round(age / 60_000), 'minute') : ago.format(-Math.round(age / 3_600_000), 'hour')}
    </p>
  );
}

/**
 * The page's one request (`GET /dashboard`); each panel reads its slice. The
 * previous day's answer stays on screen while a new day's loads.
 */
function useDashboard<T>(select: (board: DashboardData) => T) {
  const client = useQueryClient();
  return useQuery({
    queryKey: qk.dashboard(toLocalISODate()),
    queryFn: ({ signal }) => fetchDashboard(client, signal),
    select,
    placeholderData: keepPreviousData,
  });
}

/** A panel whose slice the dashboard could not read. */
function Unavailable({ what, retry }: { what: string; retry: () => void }) {
  return (
    <p className="text-xs font-sans text-danger-red">
      {what} indisponible.{' '}
      <button type="button" onClick={retry} className="text-neon-cyan hover:underline">
        Réessayer
      </button>
    </p>
  );
}

/** The dashboard's one way to log a session (the nav's Journal is the other). */
function LogSessionLink() {
  return (
    <Link to="/log?new=1" className="text-neon-gold hover:text-neon-gold/80 transition-colors">
      Saisir une séance <span aria-hidden>→</span>
    </Link>
  );
}

function SectionHeader({ icon, title, term }: { icon: React.ReactNode; title: string; term?: GlossaryId }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      {icon}
      <h2 className="text-[15px] font-sans font-medium text-text-primary">{title}</h2>
      {term && <GlossaryLink term={term} about={`section ${title.toLowerCase()}`} />}
    </div>
  );
}

/** A recovery row's label with the "?" of its term. */
function TermLabel({ term, label }: { term: GlossaryId; label: string }) {
  return (
    <span className="flex items-center gap-1 text-xs font-sans text-text-muted">
      {label}
      <GlossaryLink term={term} about={label} />
    </span>
  );
}

/**
 * One bar of the day's form. Without the RPG it reads in plain words (the
 * coach's: préparation, fraîcheur, charge); with it, the HP/MP/TSS tags lead.
 * The detail stays on screen: a `title` never shows on a phone.
 */
function FormBar({ stat, color, tag, term }: { stat: StatBar; color: string; tag?: string; term: GlossaryId }) {
  const value = (
    <span className="text-xs font-sans text-text-secondary tabular-nums">
      {Math.round(stat.current)}/{Math.round(stat.max)}
    </span>
  );
  const bar = (
    <div className="flex-1 h-3 bg-shadow rounded-full overflow-hidden">
      <div
        className={cn('h-full rounded-full transition-all duration-500 motion-reduce:transition-none', color)}
        style={{ width: `${Math.min(100, (stat.current / stat.max) * 100)}%` }}
      />
    </div>
  );
  if (!tag)
    return (
      <div>
        <div className="flex items-baseline justify-between gap-3 mb-1">
          <span className="flex items-center gap-1 self-center text-xs font-sans text-text-primary">
            {stat.label}
            <GlossaryLink term={term} about={`barre ${stat.label}`} />
          </span>
          {value}
        </div>
        {bar}
        {stat.detail && <p className="mt-0.5 text-[11px] font-sans text-text-muted">{stat.detail}</p>}
      </div>
    );
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="text-xs font-sans text-text-muted w-8">{tag}</span>
        {bar}
        <span className="w-20 text-right">{value}</span>
      </div>
      <div className="flex flex-wrap justify-between gap-x-2 pl-11 pr-1 text-[11px] font-sans text-text-muted">
        <span className="flex items-center gap-1">
          {stat.label}
          <GlossaryLink term={term} about={`barre ${stat.label}`} />
        </span>
        {stat.detail && <span>{stat.detail}</span>}
      </div>
    </div>
  );
}

/**
 * Today's planned session with its adaptation and the Garmin controls. The
 * Garmin line comes from the export view (`view`), the circuit Planning and
 * the morning push share; without it only a recorded push time shows.
 */
function TodaySession({
  row,
  decision,
  view,
  onRenegotiated,
  onReverted,
}: {
  row: DayLink['planned'][number];
  decision: PlanDecision | null;
  view: WorkoutView | undefined;
  onRenegotiated: (done: Renegotiation) => void;
  onReverted: (outcome: DayOutcome) => void;
}) {
  const queryClient = useQueryClient();
  const { session, realised, state } = row;
  // Still to do and not already adjusted today (« Rétablir » first): the athlete renegotiates it.
  const renegotiable =
    !realised && state === 'pending' && session.session_type !== 'race' && !(decision && !decision.reverted_at && decision.decision !== 'keep');
  // A decision read from another tab removes the open menu: the focus it held stays on the card.
  const anchor = useRef<HTMLDivElement>(null);
  const menuFocused = useRef(false);
  useEffect(() => {
    if (renegotiable || !menuFocused.current) return;
    menuFocused.current = false;
    if (!document.activeElement || document.activeElement === document.body) anchor.current?.focus();
  }, [renegotiable]);

  const skipped = session.status === 'skipped';
  const push = useMutation({
    // A skipped session's copy is withdrawn; otherwise sent to Garmin Connect
    // only, and the watch takes it at its next phone sync.
    mutationFn: () => (skipped ? exportApi.remove(session.id) : exportApi.export(session.id, null)),
    onSettled: () => invalidateAfterSession(queryClient),
  });
  const revert = useMutation({
    mutationFn: (decisionId: number) => planApi.revert(decisionId),
    // The reverted session is no longer the copy sent: forget the local answer.
    onSuccess: (reverted) => {
      push.reset();
      onReverted(revertOutcome(reverted.garmin, 'Séance prévue rétablie.'));
    },
    // 409: reverted elsewhere, or changed since (its message says so); a refetch shows it.
    onSettled: () => invalidateAfterSession(queryClient),
  });

  const watch =
    view && !realised && (state === 'pending' || state === 'skipped')
      ? watchLine(view, session.garmin_pushed_at, {
          run: () => push.mutate(),
          pending: push.isPending,
          error: push.error ? readableError(push.error) : null,
          result: push.data ?? null,
        })
      : undefined;

  return (
    <div
      ref={anchor}
      tabIndex={-1}
      role="group"
      aria-label={`Séance du jour : ${SESSION_TYPE_LABEL[session.session_type] ?? session.session_type}`}
      className="focus:outline-none"
    >
    <SessionCard
      planned={session}
      realised={realised}
      state={state}
      decision={decision}
      busy={revert.isPending}
      onRevert={decision ? () => revert.mutate(decision.id) : undefined}
      push={watch}
    >
      {revert.error && (
        <p role="alert" className="mt-1 text-[11px] font-sans text-danger-red">
          {readableError(revert.error)}
        </p>
      )}
      {renegotiable && (
        <div
          onFocus={() => (menuFocused.current = true)}
          // Removal blurs with no target: the focus was still in the menu.
          onBlur={(event) => {
            if (event.relatedTarget) menuFocused.current = false;
          }}
        >
          <RenegotiateMenu session={session} onDone={onRenegotiated} />
        </div>
      )}
    </SessionCard>
    </div>
  );
}

export function DashboardPage() {
  // Unknown until read: plain words meanwhile, never a flash of game vocabulary.
  const rpg = useGamePreference().data?.enabled === true;

  // The app shell already reads the settings: the same key, no second request.
  const { data: userSettings } = useQuery({ queryKey: qk.settings, queryFn: settingsApi.get });
  const { data: nextGoal } = useDashboard((d) => d.next_goal);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const fatigueThreshold = userSettings?.fatigue_threshold ?? 85;

  // The server's day: today's rows are the ones it read for that date.
  const {
    data: dayLink,
    isPending: plannedPending,
    isFetching: boardFetching,
    error: boardError,
    refetch: retryBoard,
    dataUpdatedAt: plannedAt,
  } = useDashboard((d) => linkDay(d.date, d.planned, withStrengthLogs(d.actual, d.strength), d.date));
  const todayLink: DayLink = dayLink ?? { planned: [], offPlan: [] };
  // No answer at all: the panels say so instead of an empty day.
  const boardFailed = !!boardError && dayLink === undefined;
  // The coach card and the briefing read their own keys, which the dashboard
  // seeds: they ask the server themselves only once it has answered or failed.
  const boardSettled = !plannedPending && !boardFetching;
  const { data: boardDay } = useDashboard((d) => d.date);

  // Unknown until the dashboard answers: no Garmin call to action meanwhile.
  const { data: garminConnected } = useDashboard((d) => d.garmin_connected);
  // One batched export view for the day's sessions still to do or skipped
  // (a skipped copy still on Garmin can be withdrawn), as Planning's cards.
  const queryClient = useQueryClient();
  const watchIds = garminConnected
    ? todayLink.planned
        .filter((r) => !r.realised && (r.state === 'pending' || r.state === 'skipped'))
        .map((r) => r.session.id)
    : [];
  const { data: workouts } = useQuery({
    queryKey: workoutsKey('cards', watchIds),
    queryFn: () => readWorkouts(queryClient, watchIds),
    enabled: watchIds.length > 0,
    retry: false,
  });
  const viewFor = (sessionId: number) => workouts?.workouts.find((w) => w.session.id === sessionId);

  const { data: planToday } = useDashboard((d) => d.plan_today);
  const decisionFor = (sessionId: number) =>
    planToday?.decisions.find((d) => d.planned_session_id === sessionId && d.applied_at) ?? null;
  // A session moved away today leaves its decision here, with its « Rétablir ».
  const moved = (planToday?.decisions ?? []).filter(
    (d) =>
      d.decision === 'move' &&
      d.applied_at &&
      !d.reverted_at &&
      !todayLink.planned.some((row) => row.session.id === d.planned_session_id),
  );
  // The last « Modifier » answer, shown above the day's sessions until dismissed.
  const [outcome, setOutcome] = useState<DayOutcome | null>(null);


  const {
    data: playerStats,
    isPending: statsPending,
    error: statsError,
    refetch: refetchStats,
  } = useDashboard((d) => d.player_stats);

  const { data: fitness } = useDashboard((d) => d.fitness);

  const { data: workload } = useDashboard((d) => d.workload);

  const { data: healthData, isPending: healthPending } = useDashboard((d) => d.health);
  // No row for the board's day yet, while yesterday's Garmin night drives the recovery.
  const fromGarmin = fitness != null && fitness.readiness_source !== 'model';
  const morningScore = fitness?.readiness_score ?? null;
  // A sync before the watch uploads the night still writes the day's row, empty.
  const morningIn =
    healthData != null &&
    (healthData.training_readiness_score != null ||
      healthData.readiness_score != null ||
      healthData.hrv_last_night != null ||
      healthData.sleep_score != null ||
      healthData.stress_avg != null);
  const { data: hasLoad } = useDashboard((d) => d.has_load);
  // Null until today is answered; undefined until the dashboard says (or from a server without it).
  const { data: checkin } = useDashboard((d) => d.checkin);
  // The week's review waiting for an answer: a field of the same answer, no request.
  const { data: weekReview } = useDashboard((d) => d.weekly_review ?? null);
  // The check-in push opens `/?checkin=1`: the card shows and takes the focus,
  // once; the parameter then goes, so a reload keeps « Plus tard ».
  const [params, setParams] = useSearchParams();
  const checkinFocused = useCallback(
    () =>
      setParams(
        (current) => {
          current.delete('checkin');
          return current;
        },
        { replace: true },
      ),
    [setParams],
  );

  const completed = [...todayLink.planned.flatMap(row => row.realised ? [row.realised] : []), ...todayLink.offPlan];
  const completedSeconds = completed.reduce((sum, session) => sum + session.duration_sec, 0);

  const { tip, writing: tipWriting, stalled: tipStalled, refresh: refreshTip } = useDailyTip({
    enabled: boardSettled,
    day: boardDay,
  });

  return (
    <div className="page-shell bg-void">
      <div className="page-content dashboard-content dashboard-home space-y-4">
        <header className="flex justify-between items-center gap-3 animate-fade-down">
          <div className="min-w-0">
            <p className="mb-2 text-xs font-sans text-text-muted first-letter:uppercase">{new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
            <h1 className="page-title">
              Bonjour, <span className="text-neon-cyan">{userSettings?.display_name || 'Athlète'}</span>
            </h1>
            <p className="mt-2 text-sm text-text-secondary">
              {nextGoal ? <Link className="inline-flex min-h-11 items-center hover:text-neon-cyan" to="/settings?tab=goals">{nextGoal.name} · {nextGoal.days_left > 0 ? `J-${nextGoal.days_left}` : 'Jour J'}</Link>
                : nextGoal === null ? <Link className="inline-flex min-h-11 items-center hover:text-neon-cyan" to="/settings?tab=goals">Fixer un objectif</Link> : null}
            </p>
            <UpdatedAgo at={plannedAt} />
          </div>
          {/* Regularity, not a level: a missed week lowers it by one, never to zero. */}
          {playerStats && playerStats.recent_weeks > 0 && (
            <div className="shrink-0 text-right">
              <div
                aria-hidden
                className="ml-auto text-sm font-medium tabular-nums text-text-secondary"
              >
                {playerStats.recent_weeks_at_goal}/{playerStats.recent_weeks}
              </div>
              <p aria-hidden className="text-[11px] font-sans text-text-muted mt-1 max-w-[8rem] ml-auto leading-tight">
                {playerStats.recent_weeks > 1 ? 'semaines' : 'semaine'} à l’objectif de charge
              </p>
              <p className="sr-only">
                Régularité : {weeksAtGoalText(playerStats.recent_weeks_at_goal, playerStats.recent_weeks)}
              </p>
            </div>
          )}
        </header>

        {/* Ten seconds before the briefing: the answer feeds the day's decision. */}
        {checkin === null && boardDay && (
          <CheckinCard
            key={boardDay}
            day={boardDay}
            focus={params.get('checkin') === '1'}
            onFocused={checkinFocused}
          />
        )}

        {weekReview && <WeekReviewEntry open={weekReview.open} />}

        <Panel className="dashboard-panel">
          <BriefingCard tip={tip} writing={tipWriting} stalled={tipStalled} refresh={refreshTip} />
        </Panel>

        <div className="dashboard-overview">
          <Panel className="dashboard-panel">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-base font-medium">Tes séances</h2>
              <Link to="/planning" className="inline-flex min-h-11 items-center text-sm text-neon-cyan">Planning</Link>
            </div>
            {plannedPending ? (
              <Skeleton label="Chargement de la séance du jour" />
            ) : boardFailed ? (
              <Unavailable what="Séance du jour" retry={() => void retryBoard()} />
            ) : todayLink.planned.length > 0 || todayLink.offPlan.length > 0 || moved.length > 0 ? (
              <div className="space-y-2">
                {outcome && <RenegotiationOutcome outcome={outcome} onDismiss={() => setOutcome(null)} />}
                {todayLink.planned.map((row) => (
                  row.realised ? <CompletedSession key={row.session.id} session={row.realised} /> : <TodaySession
                    key={row.session.id}
                    row={row}
                    decision={decisionFor(row.session.id)}
                    view={viewFor(row.session.id)}
                    onRenegotiated={(done) => setOutcome(renegotiationOutcome(done))}
                    onReverted={setOutcome}
                  />
                ))}
                {moved.map((decision) => (
                  <MovedSession
                    key={decision.id}
                    decision={decision}
                    onReverted={(garmin) => setOutcome(revertOutcome(garmin))}
                  />
                ))}
                {todayLink.offPlan.map((a) => (
                  <CompletedSession key={a.id} session={a} offPlan />
                ))}
                {completed.length > 0 && <p className="pt-2 text-xs text-text-muted">{completed.length} séance{completed.length > 1 ? 's' : ''} terminée{completed.length > 1 ? 's' : ''}{completedSeconds > 0 ? ` · ${formatHoursMinutes(completedSeconds)} au total` : ''}</p>}
                {/* A session just arrived: the moment the coach's feedback by push makes sense. */}
                {(todayLink.offPlan.length > 0 || todayLink.planned.some((row) => row.realised)) && (
                  <PushOffer moment="session" />
                )}
                <div className="flex justify-end items-center gap-4 pt-1 text-xs font-sans">
                  <LogSessionLink />
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-shadow/30 p-4">
                <p className="text-sm font-sans text-text-muted">Repos — aucune séance prévue</p>
                <div className="flex items-center gap-4 text-xs font-sans">
                  <Link to="/planning?new=1" className="text-neon-cyan hover:underline">
                    + Planifier une séance
                  </Link>
                  <LogSessionLink />
                </div>
              </div>
            )}
          </Panel>

          <DailyMarkers fitness={fitness} checkin={checkin} stats={playerStats} day={boardDay} expanded={detailsOpen} onDetails={() => setDetailsOpen(open => !open)} />
        </div>
        <CoachingAttention enabled={boardSettled} home />
        <div id="dashboard-details">
        {detailsOpen && <div className="dashboard-overview">
            {nextGoal && <Suspense fallback={<Skeleton label="Chargement de l’objectif" lines={1} />}>
              <GoalCard goal={nextGoal} day={boardDay} ready={boardSettled} />
            </Suspense>}
            {/* Block 2: Player Status */}
            <Panel className="p-4">
              <SectionHeader
                icon={<Dumbbell className="w-4 h-4 text-neon-gold" />}
                title={rpg ? 'État du joueur' : 'Ma forme du jour'}
              />
              <PlayerSummary />

              {statsPending ? (
                <Skeleton label="Chargement des statistiques" lines={3} className="mb-4" />
              ) : statsError ? (
                <p className="text-xs font-sans text-danger-red mb-4">
                  Statistiques indisponibles.{' '}
                  <button type="button" onClick={() => refetchStats()} className="text-neon-cyan hover:underline">
                    Réessayer
                  </button>
                </p>
              ) : (
                playerStats && (
                  <div className="space-y-3 mb-4">
                    {/* The RPG's XP is its own ledger (Profile): the weekly load stays TSS. */}
                    <FormBar stat={playerStats.hp} color="bg-danger-red" tag={rpg ? 'HP' : undefined} term="preparation" />
                    <FormBar stat={playerStats.mp} color="bg-neon-cyan" tag={rpg ? 'MP' : undefined} term="tsb" />
                    <FormBar stat={playerStats.xp} color="bg-neon-gold" tag={rpg ? 'TSS' : undefined} term="tss" />
                  </div>
                )
              )}

              <div className="grid grid-cols-2 gap-3">
                {/* Plain words first, the acronym the coach never says as a secondary line. */}
                <MetricCard
                  title="Équilibre de charge"
                  value={workload?.acwr != null ? formatDecimal(workload.acwr, 2) : '—'}
                  kind="acwr"
                  term="acwr"
                  zone={workload?.acwr_zone}
                  subtitle="ACWR · cette semaine face aux quatre dernières"
                />
                <MetricCard
                  title="Fraîcheur"
                  value={fitness?.tsb != null ? formatDecimal(fitness.tsb, 1, true) : '—'}
                  kind="form"
                  term="tsb"
                  zone={fitness?.form_zone}
                  subtitle="TSB · forme de fond moins fatigue"
                />
              </div>
            </Panel>

            {/* One curve for forme de fond, fatigue and fraîcheur: its own lazy request. */}
            <Panel className="p-4">
              <SectionHeader icon={<TrendingUp className="w-4 h-4 text-neon-cyan" />} title="Courbe de forme" term="ctl" />
              <Suspense
                fallback={
                  <div className="min-h-[19rem]">
                    <Skeleton label="Chargement de la courbe de forme" lines={6} />
                  </div>
                }
              >
                <FormCurvePanel
                  day={boardDay}
                  ready={boardSettled}
                  hasLoad={hasLoad}
                  failed={boardFailed}
                  retry={() => void retryBoard()}
                />
              </Suspense>
            </Panel>

            {/* Block 3: Readiness (Garmin) */}
            <Panel className="p-4">
              <SectionHeader icon={<Zap className="w-4 h-4 text-neon-gold" />} title="Préparation" term="preparation" />

              {healthPending ? (
                <Skeleton label="Chargement de la préparation" />
              ) : boardFailed ? (
                <Unavailable what="Préparation" retry={() => void retryBoard()} />
              ) : healthData && morningIn ? (
                // This morning's row is in: its numbers show even when Arete's own
                // score is missing (an HRV fetch that failed leaves only Garmin's).
                <div className="flex items-center gap-6">
                  <div className="flex-shrink-0 flex flex-col items-center gap-1">
                    <div
                      className={cn(
                        'w-20 h-20 rounded-full bg-abyss border-2 flex items-center justify-center',
                        morningScore != null ? readinessTone(morningScore, fatigueThreshold) : 'text-text-muted border-text-muted/40'
                      )}
                    >
                      <span className="text-2xl font-sans font-bold">{morningScore ?? '—'}</span>
                    </div>
                    {morningScore != null && (
                      <span className="text-[11px] font-sans text-text-secondary first-letter:uppercase">
                        Préparation {readinessWord(morningScore, fatigueThreshold)}
                      </span>
                    )}
                  </div>

                  <div className="flex-1 grid grid-cols-2 gap-x-6 gap-y-1.5">
                    {healthData.training_readiness_score != null && (
                      <>
                        <TermLabel term="preparation" label="Préparation Garmin" />
                        <span className="text-xs font-sans text-text-primary text-right">
                          {healthData.training_readiness_score}/100
                        </span>
                      </>
                    )}
                    {healthData.hrv_last_night != null && (
                      <>
                        <TermLabel term="vfc" label="VFC" />
                        <span className="text-xs font-sans text-text-primary text-right">
                          {healthData.hrv_last_night} ms
                          {healthData.hrv_status && HRV_WORD[healthData.hrv_status] && (
                            <span className="block text-[11px] text-text-secondary">VFC {HRV_WORD[healthData.hrv_status]}</span>
                          )}
                        </span>
                      </>
                    )}
                    {healthData.sleep_score != null && (
                      <>
                        <TermLabel term="sommeil" label="Sommeil" />
                        <span className="text-xs font-sans text-text-primary text-right">
                          {healthData.sleep_score}/100
                          {healthData.sleep_duration_sec != null && (
                            <span className="text-[11px] text-text-muted ml-1">
                              ({formatHoursMinutes(healthData.sleep_duration_sec)})
                            </span>
                          )}
                        </span>
                      </>
                    )}
                    {healthData.stress_avg != null && (
                      <>
                        <TermLabel term="stress" label="Stress" />
                        <span className="text-xs font-sans text-right">
                          <span className={stressTone(healthData.stress_avg)}>{healthData.stress_avg}</span>
                          <span className="block text-[11px] text-text-secondary">Stress {stressWord(healthData.stress_avg)}</span>
                        </span>
                      </>
                    )}
                    {healthData.steps != null && (
                      <>
                        <span className="text-xs font-sans text-text-muted">Pas</span>
                        <span className="text-xs font-sans text-text-primary text-right">
                          {healthData.steps.toLocaleString('fr-FR')}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-sm font-sans text-text-muted">
                  {/* Yesterday's Garmin night still drives the recovery above: Garmin
                      is known, only this morning's sync is missing. */}
                  {fromGarmin ? 'Pas encore synchronisé ce matin.' : 'Pas de données santé aujourd’hui.'}{' '}
                  {garminConnected !== undefined && (
                    <Link
                      to={garminConnected ? '/settings?tab=system' : '/settings?tab=connections'}
                      className="text-neon-cyan hover:underline"
                    >
                      {garminConnected ? 'Synchroniser' : fromGarmin ? 'Reconnecter Garmin' : 'Connecter Garmin'}
                    </Link>
                  )}
                </p>
              )}
            </Panel>

            {/* Pain and weight in a few taps, after the day's form (which stays above
                the fold): no read until the athlete opens a form. */}
            <Panel className="p-4">
              <SectionHeader icon={<HeartPulse className="w-4 h-4 text-neon-cyan" />} title="Douleur ou poids" />
              <p className="mb-3 text-xs font-sans text-text-muted">
                Une gêne, une douleur, ton poids du jour : le coach en tient compte.
              </p>
              <BodyLogEntry />
            </Panel>

        </div>}
        </div>
      </div>
    </div>
  );
}
