import { CoachTodayPanel } from '@/components/agent/CoachToday';
import { AretePresence } from '@/components/AreteBrand';
import { PlayerSummary } from '@/components/PlayerSummary';
import { useGamePreference } from '@/lib/gamification';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, Calendar, Dumbbell, Flag, Zap } from 'lucide-react';
import { LoadingState, MetricCard, OffPlanRow, SessionCard, strengthAsActual } from '@/components';
import { Panel } from '@/components/ui';
import { ApiError, garminApi, garminHealthApi, goalsApi, metricsApi, planApi, settingsApi, tipsApi } from '@/lib/api';
import { formatHoursMinutes } from '@/lib/fr';
import { goalCountdown } from '@/lib/race';
import { cn } from '@/lib/utils';
import { toLocalISODate } from '@/lib/dates';
import { invalidateAfterSession, qk, strengthSessionsQuery } from '@/lib/queryKeys';
import { linkDay, type DayLink } from '@/lib/sessionMatch';
import type { PlanDecision } from '@/types';

/** Readiness / stress traffic lights as Tailwind classes (theme colors).
 *  `threshold` is the user's fatigue threshold from Settings (default 85). */
const readinessTone = (score: number, threshold: number) =>
  score >= threshold
    ? 'text-neon-cyan border-neon-cyan'
    : score >= threshold * 0.6
      ? 'text-neon-gold border-neon-gold'
      : 'text-danger-red border-danger-red';
const stressTone = (avg: number) => (avg > 40 ? 'text-danger-red' : avg > 25 ? 'text-neon-gold' : 'text-success-green');



function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      {icon}
      <h2 className="text-sm font-sans text-text-muted uppercase tracking-wider">{title}</h2>
    </div>
  );
}

/**
 * Today's planned session with its adaptation and the Garmin controls. The watch
 * structure is fetched only here, for a session still to do and not yet sent.
 */
function TodaySession({
  row,
  decision,
  garminConnected,
}: {
  row: DayLink['planned'][number];
  decision: PlanDecision | null;
  garminConnected: boolean;
}) {
  const queryClient = useQueryClient();
  const { session, realised, state } = row;

  const push = useMutation({
    mutationFn: () => garminApi.pushToWatch(session.id),
    onSuccess: () => invalidateAfterSession(queryClient),
  });
  const revert = useMutation({
    mutationFn: (decisionId: number) => planApi.revert(decisionId),
    // The server drops the Garmin copy on revert: forget the local one too.
    onSuccess: () => push.reset(),
    // 409 means it was already reverted elsewhere: a refetch shows it.
    onSettled: () => invalidateAfterSession(queryClient),
  });

  const pushedAt = session.garmin_pushed_at ?? push.data?.garmin_pushed_at ?? null;
  const wantsStructure = garminConnected && !realised && state === 'pending' && !pushedAt;
  const { data: structure } = useQuery({
    queryKey: qk.plannedStructure(session.id),
    queryFn: () => garminApi.getStructure(session.id),
    enabled: wantsStructure,
    staleTime: 1000 * 60 * 5,
    retry: false,
  });

  const pushError = push.error
    ? push.error instanceof ApiError && push.error.detail
      ? push.error.detail
      : 'Envoi à Garmin impossible, réessaie plus tard.'
    : null;

  return (
    <SessionCard
      planned={pushedAt === session.garmin_pushed_at ? session : { ...session, garmin_pushed_at: pushedAt }}
      realised={realised}
      state={state}
      decision={decision}
      busy={revert.isPending}
      onRevert={decision ? () => revert.mutate(decision.id) : undefined}
      push={
        wantsStructure && structure?.pushable
          ? { text: structure.text, onPush: () => push.mutate(), pending: push.isPending, error: pushError }
          : undefined
      }
    />
  );
}

export function DashboardPage() {
  const game = useGamePreference();
  const today = toLocalISODate();

  const { data: userSettings } = useQuery({ queryKey: qk.settings, queryFn: settingsApi.get });
  const { data: nextGoal } = useQuery({ queryKey: qk.nextGoal, queryFn: goalsApi.next });
  const fatigueThreshold = userSettings?.fatigue_threshold ?? 85;

  const { data: allPlanned, isLoading: plannedLoading } = useQuery({
    queryKey: qk.planned(today, today),
    queryFn: () => garminApi.getPlanned(today, today),
  });
  const { data: todayActual } = useQuery({
    queryKey: qk.actual(today, today),
    queryFn: () => garminApi.getActual(today, today),
  });
  const { data: todayStrength } = useQuery({
    ...strengthSessionsQuery,
    select: (data) => data.filter((s) => s.date === today).map(strengthAsActual),
  });
  const todayLink = linkDay(today, allPlanned ?? [], [...(todayActual ?? []), ...(todayStrength ?? [])], today);

  const { data: syncStatus } = useQuery({ queryKey: qk.syncStatus, queryFn: garminApi.getSyncStatus });
  const garminConnected = syncStatus?.garmin_authenticated ?? false;

  const { data: planToday } = useQuery({ queryKey: qk.planToday, queryFn: planApi.getToday });
  const decisionFor = (sessionId: number) =>
    planToday?.decisions.find((d) => d.planned_session_id === sessionId && d.applied_at) ?? null;


  const {
    data: playerStats,
    isLoading: statsLoading,
    error: statsError,
    refetch: refetchStats,
  } = useQuery({
    queryKey: qk.playerStats,
    queryFn: metricsApi.getPlayerStats,
  });

  const { data: fitness } = useQuery({
    queryKey: qk.fitness,
    queryFn: metricsApi.getFitness,
  });

  const { data: workload } = useQuery({ queryKey: qk.workload, queryFn: metricsApi.getWorkload });

  const { data: healthData } = useQuery({
    queryKey: qk.healthDaily(today),
    queryFn: () => garminHealthApi.getDaily(today),
    retry: false,
  });

  const { data: tip, isLoading: tipLoading } = useQuery({
    queryKey: qk.tipDaily,
    queryFn: tipsApi.getDaily,
    staleTime: 1000 * 60 * 30,
  });

  if (plannedLoading || statsLoading) {
    return <LoadingState message="CHARGEMENT DU TABLEAU DE BORD…" />;
  }

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
            {nextGoal && (
              <Link
                to="/planning"
                className="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded border border-neon-gold/30 bg-neon-gold/10 px-2 py-0.5 text-[11px] font-sans text-neon-gold hover:bg-neon-gold/20 transition-colors"
              >
                <Flag className="w-3 h-3 shrink-0" />
                <span className="truncate">{goalCountdown(nextGoal)}</span>
              </Link>
            )}
          </div>
          {playerStats && (
            <div className="text-right">
              <div
                className="w-12 h-12 ml-auto flex items-center justify-center rounded-full bg-abyss border-2 border-neon-gold font-sans text-neon-gold text-lg font-bold shadow-[0_0_12px_color-mix(in_srgb,var(--color-neon-gold)_30%,transparent)] transition-transform hover:scale-105"
                title={`${playerStats.weeks_at_goal} semaines à l'objectif au total`}
              >
                {playerStats.level}
              </div>
              <p className="text-[11px] font-sans text-text-muted mt-1">
                {playerStats.level > 0
                  ? `${playerStats.level} sem. d'affilée`
                  : 'Niveau · semaines à l’objectif'}
              </p>
            </div>
          )}
        </header>

        <div className="dashboard-grid">
          <div className="dashboard-primary">
            {/* Block 1: Today's Plan */}
            <Panel className="p-4">
              <SectionHeader icon={<Calendar className="w-4 h-4 text-neon-purple" />} title="SÉANCE DU JOUR" />
              {todayLink.planned.length > 0 || todayLink.offPlan.length > 0 ? (
                <div className="space-y-2">
                  {todayLink.planned.map((row) => (
                    <TodaySession
                      key={row.session.id}
                      row={row}
                      decision={decisionFor(row.session.id)}
                      garminConnected={garminConnected}
                    />
                  ))}
                  {todayLink.offPlan.map((a) => (
                    <OffPlanRow key={a.id} session={a} />
                  ))}
                  <div className="flex justify-end items-center gap-4 pt-1 text-xs font-sans">
                    <Link to="/planning" className="text-neon-cyan hover:underline">
                      Semaine →
                    </Link>
                    <Link to="/log" className="text-neon-gold hover:text-neon-gold/80 transition-colors">
                      Saisir la séance →
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-shadow/30 p-4">
                  <p className="text-sm font-sans text-text-muted">Repos — aucune séance prévue</p>
                  <Link to="/planning?new=1" className="text-xs font-sans text-neon-cyan hover:underline">
                    + Ajouter une séance
                  </Link>
                </div>
              )}
            </Panel>

            {/* Block 4: AI Tip — the first visit of the day may wait for the coach */}
            {tipLoading && (
              <p className="glass-panel p-4 text-sm font-sans text-text-muted flex items-center gap-2">
                <AretePresence size={24} />
                Le coach écrit ton briefing…
              </p>
            )}
            <CoachTodayPanel briefing={tip?.tip} />

            {/* Quick Actions Footer */}
            <div className="flex gap-3 animate-fade-in" style={{ animationDelay: '0.3s' }}>
              <Link
                to="/log"
                className="flex-1 flex items-center justify-center gap-2 glass-panel px-4 py-3 text-sm font-sans text-neon-cyan hover:bg-abyss/80 transition-colors"
              >
                <Dumbbell className="w-4 h-4" />
                Saisir une séance
                <ArrowRight className="w-3 h-3" />
              </Link>
              <Link
                to="/planning"
                className="flex-1 flex items-center justify-center gap-2 glass-panel px-4 py-3 text-sm font-sans text-neon-purple hover:bg-abyss/80 transition-colors"
              >
                <Calendar className="w-4 h-4" />
                Voir le planning
                <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
          </div>
          <div className="dashboard-secondary">
            {/* Block 2: Player Status */}
            <Panel className="p-4" delay={0.1}>
              <SectionHeader icon={<Dumbbell className="w-4 h-4 text-neon-gold" />} title="ÉTAT DU JOUEUR" />
              <PlayerSummary />

              {statsError ? (
                <p className="text-xs font-sans text-danger-red mb-4">
                  Statistiques indisponibles.{' '}
                  <button type="button" onClick={() => refetchStats()} className="text-neon-cyan hover:underline">
                    Réessayer
                  </button>
                </p>
              ) : (
                playerStats && (
                  <div className="space-y-3 mb-4">
                    {[
                      { stat: playerStats.hp, color: 'bg-danger-red', tag: 'HP' },
                      { stat: playerStats.mp, color: 'bg-neon-cyan', tag: 'MP' },
                      { stat: playerStats.xp, color: 'bg-neon-gold', tag: game.data?.enabled ? 'TSS' : 'XP' },
                    ].map(({ stat, color, tag }) => (
                      <div key={tag} title={stat.detail ?? undefined}>
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-sans text-text-muted w-8">{tag}</span>
                          <div className="flex-1 h-3 bg-shadow rounded-full overflow-hidden">
                            <div
                              className={cn('h-full rounded-full transition-all duration-500', color)}
                              style={{ width: `${Math.min(100, (stat.current / stat.max) * 100)}%` }}
                            />
                          </div>
                          <span className="text-xs font-sans text-text-secondary w-20 text-right">
                            {Math.round(stat.current)}/{Math.round(stat.max)}
                          </span>
                        </div>
                        <div className="flex justify-between pl-11 pr-1 text-[11px] font-sans text-text-muted">
                          <span>{stat.label}</span>
                          {stat.detail && <span className="truncate ml-2">{stat.detail}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )
              )}

              <div className="grid grid-cols-2 gap-3">
                <MetricCard
                  title="Charge (ACWR)"
                  value={workload?.acwr?.toFixed(2) ?? '—'}
                  kind="acwr"
                  zone={workload?.acwr_zone}
                />
                <MetricCard
                  title="Fraîcheur (TSB)"
                  value={
                    fitness?.tsb != null ? `${fitness.tsb > 0 ? '+' : ''}${fitness.tsb.toFixed(1)}` : '—'
                  }
                  kind="form"
                  zone={fitness?.form_zone}
                />
              </div>
            </Panel>

            {/* Block 3: Readiness (Garmin) */}
            <Panel className="p-4" delay={0.2}>
              <SectionHeader icon={<Zap className="w-4 h-4 text-neon-gold" />} title="RÉCUPÉRATION" />

              {healthData && healthData.readiness_score != null ? (
                <div className="flex items-center gap-6">
                  <div
                    className={cn(
                      'flex-shrink-0 w-20 h-20 rounded-full bg-abyss border-2 flex items-center justify-center',
                      readinessTone(healthData.readiness_score, fatigueThreshold)
                    )}
                  >
                    <span className="text-2xl font-sans font-bold">{healthData.readiness_score}</span>
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
                  Pas de données santé aujourd&apos;hui.{' '}
                  <Link
                    to={garminConnected ? '/settings?tab=system' : '/settings?tab=connections'}
                    className="text-neon-cyan hover:underline"
                  >
                    {garminConnected ? 'Synchroniser' : 'Connecter Garmin'}
                  </Link>
                </p>
              )}
            </Panel>

          </div>
        </div>
      </div>
    </div>
  );
}
