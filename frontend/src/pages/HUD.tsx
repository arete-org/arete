import { CoachTodayPanel } from '@/components/agent/CoachToday';
import { BriefingCard } from '@/components/BriefingCard';
import { PlayerSummary } from '@/components/PlayerSummary';
import { RpePicker } from '@/components/RpePicker';
import { useGamePreference } from '@/lib/gamification';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Calendar, Dumbbell, Sunrise, TrendingUp, Zap } from 'lucide-react';
import { MetricCard, OffPlanRow, SessionCard, withStrengthLogs } from '@/components';
import { CheckinCard } from '@/components/dashboard/CheckinCard';
import { Panel, Skeleton } from '@/components/ui';
import { planApi, settingsApi } from '@/lib/api';
import { fetchDashboard, type DashboardData } from '@/lib/dashboard';
import { exportApi } from '@/lib/documents';
import { readWorkouts, watchLine, workoutsKey, type WorkoutView } from '@/lib/workouts';
import { useDailyTip } from '@/lib/dailyTip';
import { formatDecimal, formatHoursMinutes, weeksAtGoalText } from '@/lib/fr';
import { cn } from '@/lib/utils';
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

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      {icon}
      <h2 className="text-sm font-sans text-text-muted uppercase tracking-wider">{title}</h2>
    </div>
  );
}

/**
 * One bar of the day's form. Without the RPG it reads in plain words (the
 * coach's: récupération, forme, charge); with it, the HP/MP/TSS tags lead.
 * The detail stays on screen: a `title` never shows on a phone.
 */
function FormBar({ stat, color, tag }: { stat: StatBar; color: string; tag?: string }) {
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
          <span className="text-xs font-sans text-text-primary">{stat.label}</span>
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
        <span>{stat.label}</span>
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
}: {
  row: DayLink['planned'][number];
  decision: PlanDecision | null;
  view: WorkoutView | undefined;
}) {
  const queryClient = useQueryClient();
  const { session, realised, state } = row;

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
    onSuccess: () => push.reset(),
    // 409 means it was already reverted elsewhere: a refetch shows it.
    onSettled: () => invalidateAfterSession(queryClient),
  });

  const watch =
    view && !realised && (state === 'pending' || state === 'skipped')
      ? watchLine(view, session.garmin_pushed_at, {
          run: () => push.mutate(),
          pending: push.isPending,
          error: push.error ? push.error.message || 'Garmin ne répond pas, réessaie plus tard.' : null,
          result: push.data ?? null,
        })
      : undefined;

  return (
    <SessionCard
      planned={session}
      realised={realised}
      state={state}
      decision={decision}
      busy={revert.isPending}
      onRevert={decision ? () => revert.mutate(decision.id) : undefined}
      push={watch}
    >
      {/* Cardio only: strength rows carry negative ids and their own RPE. */}
      {realised && realised.id > 0 && realised.rpe == null && <RpePicker sessionId={realised.id} className="mt-2" />}
    </SessionCard>
  );
}

export function DashboardPage() {
  // Unknown until read: plain words meanwhile, never a flash of game vocabulary.
  const rpg = useGamePreference().data?.enabled === true;

  // The app shell already reads the settings: the same key, no second request.
  const { data: userSettings } = useQuery({ queryKey: qk.settings, queryFn: settingsApi.get });
  const { data: nextGoal } = useDashboard((d) => d.next_goal);
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
  const morningScore = healthData?.readiness_score ?? healthData?.training_readiness_score ?? null;
  // A sync before the watch uploads the night still writes the day's row, empty.
  const morningIn =
    healthData != null &&
    (morningScore != null ||
      healthData.hrv_last_night != null ||
      healthData.sleep_score != null ||
      healthData.stress_avg != null);
  const { data: hasLoad } = useDashboard((d) => d.has_load);
  // Null until today is answered; undefined until the dashboard says (or from a server without it).
  const { data: checkin } = useDashboard((d) => d.checkin);
  // The check-in push opens `/?checkin=1`: the card shows and takes the focus.
  const [params] = useSearchParams();

  const { tip, day: tipDay, writing: tipWriting, stalled: tipStalled, refresh: refreshTip } = useDailyTip({
    enabled: boardSettled,
    day: boardDay,
  });

  return (
    <div className="page-shell bg-void">
      <div className="page-content dashboard-content space-y-6">
        <header className="flex justify-between items-center gap-3 animate-fade-down">
          <div className="min-w-0">
            <h1 className="page-title">
              Bonjour, <span className="text-neon-cyan">{userSettings?.display_name || 'Athlète'}</span>
            </h1>
            <p className="text-xs font-sans text-text-muted mt-0.5">
              {new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}
            </p>
            <UpdatedAgo at={plannedAt} />
          </div>
          {/* Regularity, not a level: a missed week lowers it by one, never to zero. */}
          {playerStats && playerStats.recent_weeks > 0 && (
            <div className="shrink-0 text-right">
              <div
                aria-hidden
                className="w-12 h-12 ml-auto flex items-center justify-center rounded-full bg-abyss border-2 border-neon-gold font-sans text-neon-gold text-sm font-bold tabular-nums shadow-[0_0_12px_color-mix(in_srgb,var(--color-neon-gold)_30%,transparent)]"
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

        {/* The race leads once the dashboard says whether there is one. */}
        {nextGoal !== undefined && (
          <Suspense fallback={<Skeleton label="Chargement de l’objectif" lines={1} className="glass-panel px-4 py-3" />}>
            <GoalCard goal={nextGoal} day={boardDay} ready={boardSettled} />
          </Suspense>
        )}

        <div className="dashboard-grid">
          <div className="dashboard-primary">
            {/* Ten seconds before the briefing: the answer feeds the day's decision. */}
            {checkin === null && boardDay && (
              <CheckinCard key={boardDay} day={boardDay} focus={params.get('checkin') === '1'} />
            )}

            {/* The coach's briefing leads (on a phone, right after the greeting); the first
                visit of the day may wait for the coach. */}
            <Panel className="p-4">
              <SectionHeader icon={<Sunrise className="w-4 h-4 text-neon-cyan" />} title="BRIEFING DU JOUR" />
              <BriefingCard tip={tip} day={tipDay} writing={tipWriting} stalled={tipStalled} refresh={refreshTip} />
            </Panel>

            {/* Today's plan, right below the briefing */}
            <Panel className="p-4">
              <SectionHeader icon={<Calendar className="w-4 h-4 text-neon-purple" />} title="SÉANCE DU JOUR" />
              {plannedPending ? (
                <Skeleton label="Chargement de la séance du jour" />
              ) : boardFailed ? (
                <Unavailable what="Séance du jour" retry={() => void retryBoard()} />
              ) : todayLink.planned.length > 0 || todayLink.offPlan.length > 0 ? (
                <div className="space-y-2">
                  {todayLink.planned.map((row) => (
                    <TodaySession
                      key={row.session.id}
                      row={row}
                      decision={decisionFor(row.session.id)}
                      view={viewFor(row.session.id)}
                    />
                  ))}
                  {todayLink.offPlan.map((a) => (
                    <OffPlanRow key={a.id} session={a} />
                  ))}
                  <div className="flex justify-end items-center gap-4 pt-1 text-xs font-sans">
                    <Link to="/planning" className="text-neon-cyan hover:underline">
                      Semaine <span aria-hidden>→</span>
                    </Link>
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

            <CoachTodayPanel enabled={boardSettled} refetchOnFocus={false} />

          </div>
          <div className="dashboard-secondary">
            {/* Block 2: Player Status */}
            <Panel className="p-4">
              <SectionHeader
                icon={<Dumbbell className="w-4 h-4 text-neon-gold" />}
                title={rpg ? 'ÉTAT DU JOUEUR' : 'MA FORME DU JOUR'}
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
                    <FormBar stat={playerStats.hp} color="bg-danger-red" tag={rpg ? 'HP' : undefined} />
                    <FormBar stat={playerStats.mp} color="bg-neon-cyan" tag={rpg ? 'MP' : undefined} />
                    <FormBar stat={playerStats.xp} color="bg-neon-gold" tag={rpg ? 'TSS' : undefined} />
                  </div>
                )
              )}

              <div className="grid grid-cols-2 gap-3">
                {/* Plain words first, the acronym the coach never says as a secondary line. */}
                <MetricCard
                  title="Équilibre de charge"
                  value={workload?.acwr != null ? formatDecimal(workload.acwr, 2) : '—'}
                  kind="acwr"
                  zone={workload?.acwr_zone}
                  subtitle="ACWR · cette semaine face aux quatre dernières"
                />
                <MetricCard
                  title="Forme"
                  value={fitness?.tsb != null ? formatDecimal(fitness.tsb, 1, true) : '—'}
                  kind="form"
                  zone={fitness?.form_zone}
                  subtitle="TSB · forme de fond moins fatigue"
                />
              </div>
            </Panel>

            {/* One curve for forme de fond, fatigue and forme: its own lazy request. */}
            <Panel className="p-4">
              <SectionHeader icon={<TrendingUp className="w-4 h-4 text-neon-cyan" />} title="COURBE DE FORME" />
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
              <SectionHeader icon={<Zap className="w-4 h-4 text-neon-gold" />} title="RÉCUPÉRATION" />

              {healthPending ? (
                <Skeleton label="Chargement de la récupération" />
              ) : boardFailed ? (
                <Unavailable what="Récupération" retry={() => void retryBoard()} />
              ) : healthData && morningIn ? (
                // This morning's row is in: its numbers show even when Arete's own
                // score is missing (an HRV fetch that failed leaves only Garmin's).
                <div className="flex items-center gap-6">
                  <div
                    className={cn(
                      'flex-shrink-0 w-20 h-20 rounded-full bg-abyss border-2 flex items-center justify-center',
                      morningScore != null ? readinessTone(morningScore, fatigueThreshold) : 'text-text-muted border-text-muted/40'
                    )}
                  >
                    <span className="text-2xl font-sans font-bold">{morningScore ?? '—'}</span>
                  </div>

                  <div className="flex-1 grid grid-cols-2 gap-x-6 gap-y-1.5">
                    {healthData.training_readiness_score != null && (
                      <>
                        <span className="text-xs font-sans text-text-muted">Préparation Garmin</span>
                        <span className="text-xs font-sans text-text-primary text-right">
                          {healthData.training_readiness_score}/100
                        </span>
                      </>
                    )}
                    {healthData.hrv_last_night != null && (
                      <>
                        <span className="text-xs font-sans text-text-muted">VFC</span>
                        <span className="text-xs font-sans text-text-primary text-right">
                          {healthData.hrv_last_night} ms
                          {healthData.hrv_status && (
                            <span className="text-[11px] text-neon-cyan ml-1">
                              {healthData.hrv_status === 'BALANCED' ? '⚖' : healthData.hrv_status === 'LOW' ? '↓' : '↑'}
                            </span>
                          )}
                        </span>
                      </>
                    )}
                    {healthData.sleep_score != null && (
                      <>
                        <span className="text-xs font-sans text-text-muted">Sommeil</span>
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
                        <span className="text-xs font-sans text-text-muted">Stress</span>
                        <span className={cn('text-xs font-sans text-right', stressTone(healthData.stress_avg))}>
                          {healthData.stress_avg}
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

          </div>
        </div>
      </div>
    </div>
  );
}
