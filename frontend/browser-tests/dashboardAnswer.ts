/** Today in the browser's zone, as the dashboard keys its day. */
export function localDay(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * A `GET /dashboard` answer (src/lib/dashboard.ts): an empty day with no load,
 * no Garmin night and a written briefing, unless `fields` says otherwise.
 */
export function dashboardAnswer(fields: Record<string, unknown> = {}) {
  const date = (fields.date as string | undefined) ?? localDay();
  return {
    date,
    planned: [],
    actual: [],
    strength: [],
    plan_today: { date, decisions: [] },
    next_goal: null,
    player_stats: {
      level: 0, weeks_at_goal: 0, weekly_goal_tss: 300, recent_weeks_at_goal: 0, recent_weeks: 0,
      hp: { current: 50, max: 100, label: 'Récupération', detail: 'Aucune donnée de charge ni mesure Garmin', source: 'model' },
      mp: { current: 50, max: 100, label: 'Forme', detail: 'TSB +0,0', source: 'model' },
      xp: { current: 0, max: 300, label: 'Charge de la semaine', detail: 'Objectif 300 TSS · 6 séances', source: 'model' },
    },
    fitness: {
      ctl: 0, atl: 0, tsb: 0, form_zone: 'neutral', readiness_score: 50, readiness_level: 'moderate',
      readiness_source: 'model', readiness_measured_on: null, ramp_rate: null, days_analyzed: 0,
    },
    workload: {
      acwr: null, acwr_zone: 'unknown', acwr_ewma: null, monotony: null, monotony_zone: 'unknown', strain: null,
      strain_zone: 'unknown', acute_load: 0, chronic_load: null, days_analyzed: 0,
    },
    health: null,
    garmin_connected: false,
    briefing: { status: 'ready', tip: 'Prépare tes prochaines séances.', priority: 'info', source: 'rules', generated_at: `${date}T07:00:00`, updated_after_sync: false, id: 1, first_written_at: null, reaction: null, reaction_comment: null },
    coach: { date, items: [], remaining: 0, briefing: null },
    ...fields,
  };
}
